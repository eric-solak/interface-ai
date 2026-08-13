// Human-in-the-loop escalation & control transfer.
//
// Model: exactly one controller of the live session at a time, tracked in a
// control ledger (.runtime/control.json) that both the engine process and the
// operator CLI read/write. The engine NEVER exits during a handoff — the
// browser (and therefore the authenticated session) stays alive, the human
// acts in that same window, and the engine resumes when the ledger flips
// back. Handoff protocol:
//
//   engine: stuck -> write InterventionRequest + screenshot
//           -> ledger agent->human -> inject action capture -> block
//   human:  `npm run operator` shows the request; the human works in the
//           already-open browser window; types a resolution note; CLI flips
//           ledger human->agent
//   engine: unblocks -> logs captured human actions -> re-observes state ->
//           continues (discovery) or re-verifies checkpoint (replay)

import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { ControlState, InterventionRequest } from "./types.js";
import type { Evidence } from "./evidence.js";

const RUNTIME = ".runtime";
const CONTROL = path.join(RUNTIME, "control.json");
const INTERVENTION = path.join(RUNTIME, "intervention.json");
const RESOLUTION = path.join(RUNTIME, "resolution.json");

function readJson<T>(p: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export function readControl(): ControlState {
  return (
    readJson<ControlState>(CONTROL) ?? { controller: "agent", entries: [] }
  );
}

function writeControl(state: ControlState): void {
  fs.mkdirSync(RUNTIME, { recursive: true });
  fs.writeFileSync(CONTROL, JSON.stringify(state, null, 2));
}

export function transferControl(to: "agent" | "human", reason: string, interventionId?: string): void {
  const cur = readControl();
  const from = cur.controller;
  writeControl({
    controller: to,
    interventionId: to === "human" ? interventionId : undefined,
    entries: [...cur.entries, { at: new Date().toISOString(), from, to, reason }],
  });
}

export interface HumanAction {
  at: string;
  kind: string;
  detail: string;
}

/**
 * Raise an intervention, cede control, and block until the operator hands it
 * back. Returns the human's captured actions and resolution note.
 */
export async function escalate(
  page: Page,
  evidence: Evidence,
  req: InterventionRequest
): Promise<{ actions: HumanAction[]; resolution: string }> {
  fs.mkdirSync(RUNTIME, { recursive: true });
  const shot = evidence.screenshotPath(`intervention-${req.id}.png`);
  await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
  const fullReq = { ...req, screenshot: shot, currentUrl: page.url() };
  fs.writeFileSync(INTERVENTION, JSON.stringify(fullReq, null, 2));
  fs.rmSync(RESOLUTION, { force: true });
  evidence.log("escalation.raised", { interventionId: req.id, reason: req.reason, screenshot: shot });
  transferControl("human", `intervention ${req.id}: ${req.reason}`, req.id);

  // record what the human does in the live session
  const actions: HumanAction[] = [];
  await page
    .exposeBinding("__opsCapture", (_src, kind: string, detail: string) => {
      actions.push({ at: new Date().toISOString(), kind, detail });
    })
    .catch(() => {}); // already exposed from a previous escalation
  const inject = async () => {
    for (const f of page.frames()) {
      await f
        .evaluate(() => {
          const w = window as unknown as {
            __opsHooked?: boolean;
            __opsCapture?: (k: string, d: string) => void;
          };
          if (w.__opsHooked) return;
          w.__opsHooked = true;
          const describe = (e: Element) => {
            const i = e as HTMLInputElement;
            return `${e.tagName.toLowerCase()}${i.name ? `[name=${i.name}]` : ""} "${(i.value || e.textContent || "").trim().slice(0, 40)}"`;
          };
          document.addEventListener("click", (ev) => w.__opsCapture?.("click", describe(ev.target as Element)), true);
          document.addEventListener("change", (ev) => w.__opsCapture?.("change", describe(ev.target as Element)), true);
        })
        .catch(() => {});
    }
  };
  await inject();
  page.on("framenavigated", inject); // keep capturing across navigations

  console.log("\n  ============================================================");
  console.log(`  CONTROL CEDED TO HUMAN  (intervention ${req.id})`);
  console.log(`  Reason: ${req.reason}`);
  console.log("  The live browser window stays open — act in it directly.");
  console.log("  Then run `npm run operator` (in another terminal) to review");
  console.log("  the request and hand control back.");
  console.log("  ============================================================\n");

  // block until the operator flips the ledger back
  while (readControl().controller !== "agent") {
    await new Promise((r) => setTimeout(r, 1000));
  }
  page.off("framenavigated", inject);
  const resolution = readJson<{ note: string }>(RESOLUTION)?.note ?? "(no note)";
  fs.rmSync(INTERVENTION, { force: true });
  evidence.log("escalation.resumed", {
    interventionId: req.id,
    resolution,
    humanActions: actions,
  });
  return { actions, resolution };
}

// ------------------------------------------------------------- operator CLI

export async function operatorCli(): Promise<void> {
  const req = readJson<InterventionRequest>(INTERVENTION);
  const control = readControl();
  console.log("MFCU automation — operator console (minimal surface; see REPORT.md §5)");
  console.log(`current controller: ${control.controller}`);
  if (!req || control.controller !== "human") {
    console.log("no pending intervention.");
    return;
  }
  console.log("\nPENDING INTERVENTION");
  console.log(`  id:         ${req.id}`);
  console.log(`  raised at:  ${req.raisedAt}`);
  console.log(`  mode:       ${req.mode}   capability: ${req.capabilityId ?? "-"}`);
  console.log(`  goal:       ${req.goal}`);
  console.log(`  at step:    ${req.stepId ?? "-"}`);
  console.log(`  reason:     ${req.reason}`);
  console.log(`  url:        ${req.currentUrl}`);
  console.log(`  screenshot: ${req.screenshot}`);
  console.log("\nPerform the manual steps in the live browser window that the");
  console.log("automation left open. When the flow is ready to continue, enter a");
  console.log("resolution note and control returns to the agent.\n");

  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const note = await rl.question("resolution note (empty = abort run): ");
  rl.close();
  fs.writeFileSync(RESOLUTION, JSON.stringify({ note: note || "ABORT" }, null, 2));
  transferControl("agent", note ? `resolved: ${note}` : "aborted by operator", req.id);
  console.log(note ? "control returned to agent." : "run marked aborted; control returned to agent.");
}
