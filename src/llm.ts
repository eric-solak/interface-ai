// LLM provider seam. The discovery agent talks to `Llm` only; providers:
//
//   gemini  — Google AI Studio free tier (default). Free API key, no card,
//             hard-capped quota: it rate-limits, it never bills.
//   openai  — any OpenAI-compatible endpoint (Groq free tier, local Ollama).
//   mock    — deterministic scripted policy for the bundled demo app, so the
//             whole system runs with zero keys. Test fixture only: the
//             /evidence/ discovery run is produced with a real provider.
//
// The model returns STRICT JSON; we validate with zod and retry once with
// the parse error appended before giving up.

import { z } from "zod";
import type { Observation } from "./surface.js";

// ------------------------------------------------------------- decision I/O

export interface DecisionContext {
  goal: string;
  params: Record<string, string>; // secret values already masked
  observation: Observation & { nodeList: string[] }; // numbered elements
  history: string[]; // "step 3: fill #2 (Member Number) = 12345 -> ok"
  lastError?: string;
}

export const Decision = z.object({
  reason: z.string(),
  action: z.enum(["navigate", "click", "fill", "extract", "done", "stuck"]),
  url: z.string().optional(), // navigate
  nodeIndex: z.number().int().optional(), // click | fill: index into nodeList
  value: z.string().optional(), // fill: literal or "{{param_name}}"
  // extract: locate a value cell on a legacy table screen
  extract: z
    .object({
      frame: z.string(),
      outputName: z.string(),
      outputDescription: z.string(),
      // declared up front; the runtime REJECTS an extraction whose value
      // doesn't match, so a wrong-cell locator fails fast during discovery
      expectedFormat: z.enum(["money", "date", "number", "text"]).default("text"),
      anchor: z.string().optional(), // label cell; value is the cell to its right
      rowContains: z.string().optional(), // or: row text + column index
      column: z.number().int().optional(),
    })
    .optional(),
  // done: the success checkpoint that proves the goal state was reached
  checkpointRegex: z.string().optional(),
  checkpointDescription: z.string().optional(),
  // stuck: why a human is needed
  stuckReason: z.string().optional(),
});
export type Decision = z.infer<typeof Decision>;

export const FinalizeResult = z.object({
  capabilityId: z.string().regex(/^[a-z0-9-]+$/),
  title: z.string(),
  description: z.string(),
  inputs: z.array(
    z.object({
      name: z.string(),
      type: z.enum(["string", "number"]),
      description: z.string(),
      pattern: z.string().optional(),
    })
  ),
  detectors: z.array(
    z.object({
      id: z.string(),
      textMatches: z.string(),
      classify: z.enum(["business_outcome", "recoverable", "hard_failure"]),
      outcomeCode: z.string(),
      message: z.string(),
      recovery: z
        .object({
          kind: z.enum(["click", "rerun-steps", "retry-step"]),
          clickText: z.string().optional(),
          fromStep: z.string().optional(),
          delayMs: z.number().optional(),
        })
        .optional(),
    })
  ),
});
export type FinalizeResult = z.infer<typeof FinalizeResult>;

export interface Llm {
  readonly id: string;
  decide(ctx: DecisionContext): Promise<Decision>;
  finalize(goal: string, history: string[], params: Record<string, string>): Promise<FinalizeResult>;
}

// ---------------------------------------------------------------- prompting

const SYSTEM = `You are the discovery engine of a computer-use automation system.
You drive a legacy business web app one action at a time to accomplish a goal.
You see: the goal, invocation parameters, the page's visible text per frame,
and a numbered list of interactive elements. Reply with ONE JSON object, no
markdown fences, matching:
{"reason": string,
 "action": "navigate"|"click"|"fill"|"extract"|"done"|"stuck",
 "url"?: string, "nodeIndex"?: number, "value"?: string,
 "extract"?: {"frame": string, "outputName": string, "outputDescription": string,
              "expectedFormat": "money"|"date"|"number"|"text",
              "anchor"?: string, "rowContains"?: string, "column"?: number},
 "checkpointRegex"?: string, "checkpointDescription"?: string,
 "stuckReason"?: string}
Rules:
- "fill"/"click" require nodeIndex from the element list.
- When filling a value that came from a parameter, use the placeholder
  "{{param_name}}" (the runtime substitutes the real value).
- "extract" reads a value from the page into a named output. For label:value
  rows use anchor (the exact text of the label cell). For DATA TABLES (rows of
  records under column headers) use rowContains + column (0-based, counted
  from the table's column headers) — anchor would give you the adjacent cell,
  which is usually NOT the one you want.
- Always declare expectedFormat for an extraction ("money" for balances and
  amounts). The runtime rejects extractions whose value doesn't match the
  declared format — if that happens, redo it with a corrected locator.
- After every extraction needed by the goal is done, reply "done" with a
  checkpointRegex: a regex over the final page's visible text that proves the
  goal state (match stable structure, not specific data values).
- If you cannot safely proceed, reply "stuck" with stuckReason.
- Never invent element indexes. Never act outside the current app.`;

function decisionPrompt(ctx: DecisionContext): string {
  const frames = Object.entries(ctx.observation.text)
    .map(([f, t]) => `--- frame "${f}" visible text ---\n${t.slice(0, 1500)}`)
    .join("\n");
  return `GOAL: ${ctx.goal}
PARAMETERS: ${JSON.stringify(ctx.params)}
CURRENT URL: ${ctx.observation.url}
PAGE TITLE: ${ctx.observation.title}
${frames}
--- interactive elements ---
${ctx.observation.nodeList.join("\n") || "(none)"}
--- actions so far ---
${ctx.history.join("\n") || "(none)"}
${ctx.lastError ? `--- your previous action FAILED ---\n${ctx.lastError}\nChoose a different action.` : ""}
Reply with the single next action as JSON.`;
}

const FINALIZE_SYSTEM = `You are finalizing a recorded automation capability.
Reply with ONE JSON object, no markdown fences:
{"capabilityId": kebab-case string, "title": string, "description": string,
 "inputs": [{"name","type":"string"|"number","description","pattern"?}],
 "detectors": [{"id","textMatches" (regex over page text),"classify":
   "business_outcome"|"recoverable"|"hard_failure","outcomeCode" (SCREAMING_SNAKE),
   "message", "recovery"? {"kind":"click"|"rerun-steps"|"retry-step",
   "clickText"?,"fromStep"?,"delayMs"?}}]}
Detectors are runtime-condition recognizers checked during deterministic
replay. Include the app-specific error states this flow could plausibly hit
(not-found results, permission/authorization denials, session expiry,
dismissable notices, server errors). You have only seen the happy path, so
ground regexes in text you actually saw where possible and keep guessed ones
BROAD and disjunctive (synonyms, optional words) — they are matched
case-insensitively against page text. Classifications:
business_outcome = legitimate answer for the caller; recoverable = scripted
recovery (recovery required); hard_failure = stop with debuggable error.
Inputs must cover exactly the parameters used by the flow. ALWAYS give each
non-secret input a "pattern" (an anchored JS regex, e.g. "^[0-9]{3,10}$" for a
member number) — replay validates invocation arguments against it BEFORE
touching the UI, so a missing pattern lets malformed input reach the app.`;

function finalizePrompt(goal: string, history: string[], params: Record<string, string>): string {
  return `GOAL ACCOMPLISHED: ${goal}
PARAMETERS USED: ${JSON.stringify(params)}
RECORDED STEPS:
${history.join("\n")}
Produce the capability metadata and detectors JSON.`;
}

// ----------------------------------------------------------- JSON plumbing

function extractJson(text: string): unknown {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end < 0) throw new Error(`no JSON object in model reply: ${text.slice(0, 200)}`);
  return JSON.parse(cleaned.slice(start, end + 1));
}

abstract class CompletionLlm implements Llm {
  abstract readonly id: string;
  protected abstract complete(system: string, user: string): Promise<string>;

  private async json<T>(schema: z.ZodType<T>, system: string, user: string): Promise<T> {
    let reply = await this.complete(system, user);
    for (let attempt = 0; ; attempt++) {
      try {
        return schema.parse(extractJson(reply));
      } catch (e) {
        if (attempt >= 1) throw new Error(`model returned invalid JSON twice: ${e}`);
        reply = await this.complete(
          system,
          `${user}\n\nYour previous reply was invalid (${e}). Reply again with ONLY the corrected JSON object.`
        );
      }
    }
  }

  decide(ctx: DecisionContext): Promise<Decision> {
    return this.json(Decision, SYSTEM, decisionPrompt(ctx));
  }
  finalize(goal: string, history: string[], params: Record<string, string>): Promise<FinalizeResult> {
    return this.json(FinalizeResult, FINALIZE_SYSTEM, finalizePrompt(goal, history, params));
  }
}

// -------------------------------------------------------------- providers

class GeminiLlm extends CompletionLlm {
  id: string; // mutable: updated on model failover
  private retriesLeft = 15; // across the whole run
  private sameModelRetries = 0;
  /** preferred model first; free-tier models routinely hit demand spikes, so
   *  persistent 404/503 fails over down this chain instead of killing a run */
  private models: string[];
  constructor(private key: string, model = process.env.LLM_MODEL || "gemini-flash-latest") {
    super();
    this.models = [
      ...new Set([model, "gemini-2.5-flash-lite", "gemini-3.1-flash-lite", "gemini-pro-latest", "gemma-4-31b-it"]),
    ];
    this.id = `gemini/${model}`;
  }
  protected async complete(system: string, user: string): Promise<string> {
    const model = this.models[0]!;
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": this.key },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { temperature: 0.2, responseMimeType: "application/json" },
        }),
      }
    );
    if ([404, 429, 403, 500, 503].includes(res.status) && this.retriesLeft-- > 0) {
      // 404/503: model gone/overloaded -> fail over immediately.
      // 429/403/500: wait once, then treat a repeat as exhausted quota and
      // fail over too (free-tier daily caps don't recover by waiting).
      const failNow = [404, 503].includes(res.status) || this.sameModelRetries >= 1;
      if (failNow && this.models.length > 1) {
        this.models.shift();
        this.sameModelRetries = 0;
        console.log(`  [llm] ${model} unavailable (${res.status}) -> failing over to ${this.models[0]}`);
        this.id = `gemini/${this.models[0]}`;
      } else {
        this.sameModelRetries++;
        await new Promise((r) => setTimeout(r, 15000));
      }
      return this.complete(system, user);
    }
    if (!res.ok) throw new Error(`Gemini API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
    if (!text) throw new Error("Gemini returned an empty completion");
    return text;
  }
}

class OpenAiCompatLlm extends CompletionLlm {
  readonly id: string;
  constructor(
    private baseUrl: string,
    private key: string,
    private model: string
  ) {
    super();
    this.id = `openai-compat/${model}`;
  }
  protected async complete(system: string, user: string): Promise<string> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.key}` },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`LLM API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return body.choices?.[0]?.message?.content ?? "";
  }
}

// Deterministic policy for the bundled MFCU demo app. Exists so the system is
// runnable offline; clearly labeled in evidence as mock (recordedBy: "mock").
class MockLlm implements Llm {
  readonly id = "mock";
  async decide(ctx: DecisionContext): Promise<Decision> {
    const find = (needle: string) =>
      ctx.observation.nodeList.findIndex((n) => n.toLowerCase().includes(needle.toLowerCase()));
    const textAll = Object.values(ctx.observation.text).join(" ");
    const did = (s: string) => ctx.history.some((h) => h.toLowerCase().includes(s.toLowerCase()));

    if (/Operator ID/.test(textAll) && !did("fill") ) {
      const i = find("Operator ID");
      return { reason: "login: fill operator id", action: "fill", nodeIndex: i, value: "{{operator_id}}" };
    }
    if (/Passcode/.test(textAll) && did("operator") && !did("Passcode")) {
      return { reason: "login: fill passcode", action: "fill", nodeIndex: find("Passcode"), value: "{{passcode}}" };
    }
    if (find("Sign In") >= 0 && /Passcode/.test(textAll)) {
      return { reason: "submit login", action: "click", nodeIndex: find('button "Sign In"') };
    }
    if (/Maintenance Notice/.test(textAll)) {
      return { reason: "dismiss maintenance interstitial", action: "click", nodeIndex: find("Continue") };
    }
    if (find("Member Inquiry") >= 0 && !/Member Number:/.test(ctx.observation.text["main"] ?? "")) {
      return { reason: "open member inquiry", action: "click", nodeIndex: find("Member Inquiry") };
    }
    if (/Member Number:/.test(ctx.observation.text["main"] ?? "") && !did("member_id")) {
      return { reason: "enter member number", action: "fill", nodeIndex: find("Member Number"), value: "{{member_id}}" };
    }
    if (find('button "Search"') >= 0) {
      return { reason: "run search", action: "click", nodeIndex: find('button "Search"') };
    }
    if (/Member Profile/.test(textAll) && !did("extract member_name")) {
      return {
        reason: "read member name",
        action: "extract",
        extract: { frame: "main", outputName: "member_name", outputDescription: "Member full name", expectedFormat: "text", anchor: "Name:" },
      };
    }
    if (/Member Profile/.test(textAll) && !did("extract savings_balance")) {
      return {
        reason: "read savings balance from accounts table",
        action: "extract",
        extract: {
          frame: "main",
          outputName: "savings_balance",
          outputDescription: "Current balance of the regular share savings account",
          expectedFormat: "money",
          rowContains: "Savings",
          column: 2,
        },
      };
    }
    if (/Member Profile/.test(textAll)) {
      return {
        reason: "goal complete",
        action: "done",
        checkpointRegex: "Member Profile[\\s\\S]*Accounts[\\s\\S]*Current Balance",
        checkpointDescription: "Member profile with accounts table is displayed",
      };
    }
    return { reason: "no rule matched", action: "stuck", stuckReason: "mock policy has no rule for this page" };
  }

  async finalize(): Promise<FinalizeResult> {
    return {
      capabilityId: "lookup-member-balance",
      title: "Look up member savings balance",
      description:
        "Signs into the MFCU Teller Console, searches for a member by number, and reads the member name and regular-share savings balance from the profile screen.",
      inputs: [
        { name: "member_id", type: "string", description: "Member number to look up", pattern: "^[0-9]{3,10}$" },
        { name: "operator_id", type: "string", description: "Teller operator id (secret)" },
        { name: "passcode", type: "string", description: "Teller passcode (secret)" },
      ],
      detectors: [
        { id: "member-not-found", textMatches: "No member found matching", classify: "business_outcome", outcomeCode: "MEMBER_NOT_FOUND", message: "No member exists with the given number." },
        { id: "access-restricted", textMatches: "Access restricted[\\s\\S]*supervisor", classify: "business_outcome", outcomeCode: "PERMISSION_DENIED", message: "Record requires supervisor authorization." },
        { id: "session-expired", textMatches: "session has expired", classify: "recoverable", outcomeCode: "SESSION_EXPIRED", message: "Session expired; re-authenticate and re-run from the search step.", recovery: { kind: "rerun-steps", fromStep: "s1" } },
        { id: "maintenance-notice", textMatches: "Scheduled Maintenance Notice", classify: "recoverable", outcomeCode: "MAINTENANCE_NOTICE", message: "Dismissable maintenance interstitial.", recovery: { kind: "click", clickText: "Continue" } },
        { id: "server-error", textMatches: "HTTP 500|ORA-\\d+|internal error", classify: "hard_failure", outcomeCode: "APP_SERVER_ERROR", message: "The application returned a server error." },
      ],
    };
  }
}

// -------------------------------------------------------------- selection

export function loadLlm(): Llm {
  const provider = process.env.LLM_PROVIDER ?? (process.env.GEMINI_API_KEY ? "gemini" : "mock");
  switch (provider) {
    case "gemini": {
      const key = process.env.GEMINI_API_KEY;
      if (!key) throw new Error("LLM_PROVIDER=gemini but GEMINI_API_KEY is not set");
      return new GeminiLlm(key);
    }
    case "openai": {
      const base = process.env.LLM_BASE_URL;
      const model = process.env.LLM_MODEL;
      if (!base || !model) throw new Error("LLM_PROVIDER=openai needs LLM_BASE_URL and LLM_MODEL (LLM_API_KEY optional for local servers)");
      return new OpenAiCompatLlm(base, process.env.LLM_API_KEY ?? "none", model);
    }
    case "mock":
      console.log("  [llm] no API key configured -> using MOCK provider (test fixture; use a real key for the evidence run)");
      return new MockLlm();
    default:
      throw new Error(`unknown LLM_PROVIDER "${provider}"`);
  }
}
