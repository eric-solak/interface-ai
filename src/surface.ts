// Surface abstraction: the seam between "how we perceive/act on a UI" and
// "the recorded flow". The artifact schema and both engines (discovery,
// replay) talk only to this interface. A legacy web app is this same
// implementation (the locator strategies already assume hostile markup); a
// desktop app would be a second implementation over UIA/AX-tree + OS input,
// reusing role/label/text/anchor-cell strategies against the accessibility
// tree instead of the DOM. Screenshot+coordinates would be a last-resort
// third implementation with the same contract.

import { chromium, type Browser, type Frame, type Page, type Locator } from "playwright";
import type { LocatorCandidate, Target } from "./types.js";

export interface UiNode {
  role: string;
  name: string;
  value?: string;
  frame: string;
  /** structural selector captured at observe time — recorded only as the
   *  last-resort locator candidate */
  cssPath: string;
}

export interface Observation {
  url: string;
  title: string;
  frames: string[];
  /** Interactive + salient elements, per frame, from the accessibility tree. */
  nodes: UiNode[];
  /** Visible text of each frame (trimmed) — what a human operator sees. */
  text: Record<string, string>;
}

export interface ResolvedTarget {
  locator: Locator;
  /** index of the candidate that won — >0 or css means drift warning */
  candidateIndex: number;
  strategy: string;
}

export class WebSurface {
  private browser!: Browser;
  page!: Page;

  static async launch(opts: { headed: boolean }): Promise<WebSurface> {
    const s = new WebSurface();
    s.browser = await chromium.launch({ headless: !opts.headed });
    s.page = await s.browser.newPage({ viewport: { width: 1100, height: 800 } });
    return s;
  }

  async close(): Promise<void> {
    await this.browser.close();
  }

  private frameByName(name: string): Frame {
    if (name === "top") return this.page.mainFrame();
    const f = this.page.frame({ name });
    if (!f) throw new Error(`frame "${name}" not found (frames: ${this.frameNames().join(", ")})`);
    return f;
  }

  frameNames(): string[] {
    return ["top", ...this.page.frames().filter((f) => f !== this.page.mainFrame()).map((f) => f.name()).filter(Boolean)];
  }

  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
  }

  async screenshot(path: string): Promise<void> {
    await this.page.screenshot({ path, fullPage: true });
  }

  async frameText(frame: string): Promise<string> {
    try {
      const f = this.frameByName(frame);
      // frameset documents have no <body>; read the root element instead
      const text = await f
        .locator("body")
        .innerText({ timeout: 2000 })
        .catch(() => f.evaluate(() => document.documentElement.innerText ?? ""));
      return text.replace(/\s+/g, " ").trim();
    } catch {
      return "";
    }
  }

  /** Wait until the page and all its (i)frames finished loading. */
  async settle(): Promise<void> {
    await this.page.waitForLoadState("load").catch(() => {});
    const deadline = Date.now() + 5000;
    // frames can be added while earlier ones load — loop until stable
    let prev = -1;
    while (Date.now() < deadline) {
      const frames = this.page.frames();
      await Promise.all(
        frames.map((f) => f.waitForLoadState("domcontentloaded").catch(() => {}))
      );
      if (frames.length === prev) return;
      prev = frames.length;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Observation digest for the LLM: acc-tree elements + visible text per frame. */
  async observe(): Promise<Observation> {
    await this.settle();
    const frames = this.frameNames();
    const nodes: UiNode[] = [];
    const text: Record<string, string> = {};
    for (const fname of frames) {
      const f = this.frameByName(fname);
      text[fname] = await this.frameText(fname).catch(() => "");
      for (const [role, sel] of [
        ["textbox", "input[type=text],input[type=password],input:not([type]),textarea"],
        ["button", "input[type=submit],input[type=button],button"],
        ["link", "a[href]"],
      ] as const) {
        try {
          for (const el of await f.locator(sel).all()) {
            if (!(await el.isVisible().catch(() => false))) continue;
            const name =
              role === "link" || role === "button"
                ? (await el.evaluate((e) => (e as HTMLInputElement).value || e.textContent || "")).trim()
                : await this.labelFor(f, el);
            const cssPath = await el.evaluate((e) => {
              const parts: string[] = [];
              let n: Element | null = e;
              while (n && n.tagName !== "BODY") {
                const tag = n.tagName.toLowerCase();
                const parent: Element | null = n.parentElement;
                const idx = parent ? Array.from(parent.children).filter((c) => c.tagName === n!.tagName).indexOf(n) + 1 : 1;
                parts.unshift(`${tag}:nth-of-type(${idx})`);
                n = parent;
              }
              return "body > " + parts.join(" > ");
            });
            nodes.push({ role, name, frame: fname, cssPath, ...(role === "textbox" ? { value: await el.inputValue().catch(() => "") } : {}) });
          }
        } catch {
          /* frame may navigate mid-observation; next loop catches up */
        }
      }
    }
    return { url: this.page.url(), title: await this.page.title(), frames, nodes, text };
  }

  /** Best-effort accessible label for a control in label-less legacy markup:
   *  <label for>, aria-label, name attr, or the text of the preceding cell. */
  private async labelFor(f: Frame, el: Locator): Promise<string> {
    return el.evaluate((e) => {
      const i = e as HTMLInputElement;
      if (i.labels && i.labels[0]) return i.labels[0].textContent?.trim() || "";
      if (i.getAttribute("aria-label")) return i.getAttribute("aria-label")!;
      const cell = i.closest("td");
      const prev = cell?.previousElementSibling;
      if (prev?.textContent?.trim()) return prev.textContent.trim();
      return i.name || "";
    });
  }

  // ------------------------------------------------------- locator cascade

  private candidateToLocator(f: Frame, c: LocatorCandidate): Locator {
    switch (c.strategy) {
      case "role":
        return f.getByRole(c.role as never, { name: c.name, exact: true });
      case "label-text":
        // legacy pattern: the form control in the cell following the cell
        // whose text is the label (table-layout forms with no <label for>)
        return f.locator(
          `xpath=//td[normalize-space()=${xq(c.label)}]/following-sibling::td[1]//*[self::input or self::select or self::textarea]`
        );
      case "text":
        return f.locator(`${c.element ?? "*"}:visible`, { hasText: new RegExp(`^\\s*${escapeRe(c.text)}\\s*$`) }).last();
      case "anchor-cell":
        return c.direction === "right"
          ? f.locator(`xpath=//td[normalize-space()=${xq(c.anchor)}]/following-sibling::td[1]`)
          : f.locator(`xpath=//td[normalize-space()=${xq(c.anchor)}]/ancestor::tr[1]/following-sibling::tr[1]/td[1]`);
      case "table-cell":
        return f.locator(`xpath=//tr[td[contains(normalize-space(), ${xq(c.rowContains)})]]/td[${c.column + 1}]`);
      case "css":
        return f.locator(c.css);
    }
  }

  /**
   * Resolve a Target by walking its candidate list. A candidate wins only if
   * it matches exactly one visible element within `timeoutMs`. Ambiguity (2+
   * matches) is treated as failure of that candidate, not a coin flip.
   */
  async resolve(target: Target, timeoutMs: number): Promise<ResolvedTarget> {
    // the target frame may still be appearing after a navigation — wait for it
    const frameDeadline = Date.now() + timeoutMs;
    while (target.frame !== "top" && !this.page.frame({ name: target.frame })) {
      if (Date.now() > frameDeadline)
        throw new Error(
          `frame "${target.frame}" did not appear within ${timeoutMs}ms (frames: ${this.frameNames().join(", ")})`
        );
      await new Promise((r) => setTimeout(r, 100));
    }
    const f = this.frameByName(target.frame);
    const perCandidate = Math.max(500, Math.floor(timeoutMs / target.candidates.length));
    const failures: string[] = [];
    for (let i = 0; i < target.candidates.length; i++) {
      const c = target.candidates[i]!;
      const loc = this.candidateToLocator(f, c);
      try {
        await loc.first().waitFor({ state: "visible", timeout: perCandidate });
        const n = await loc.count();
        if (n === 1) return { locator: loc, candidateIndex: i, strategy: c.strategy };
        failures.push(`${c.strategy}: matched ${n} elements`);
      } catch {
        failures.push(`${c.strategy}: no visible match`);
      }
    }
    throw new Error(
      `could not resolve "${target.description}" in frame "${target.frame}" — ${failures.join("; ")}`
    );
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Quote a string for use inside an XPath expression. */
function xq(s: string): string {
  if (!s.includes('"')) return `"${s}"`;
  if (!s.includes("'")) return `'${s}'`;
  return `concat("${s.split('"').join(`", '"', "`)}")`;
}
