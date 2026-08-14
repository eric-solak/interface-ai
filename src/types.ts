// Core data contracts. The CapabilityArtifact schema is the focal point of the
// system: it is what discovery produces, what a reviewer reads, and what the
// replay engine executes without an LLM.

import { z } from "zod";

// ---------------------------------------------------------------- locators
//
// A target is never a single selector: it is a ranked list of candidates,
// most-semantic first. Replay walks the list and requires the winning
// candidate to match EXACTLY ONE element. Semantic strategies (role/label/
// text anchor) survive cosmetic drift; the structural CSS candidate is the
// last-resort fallback and its use is reported as a drift warning.

export const LocatorCandidate = z.discriminatedUnion("strategy", [
  // Accessibility-tree role + accessible name. Most portable: works on
  // desktop apps via UIA/AX too, and on markup with no ids at all.
  z.object({ strategy: z.literal("role"), role: z.string(), name: z.string() }),
  // Form control located by nearby label text (legacy table-layout forms
  // have no <label for> — this matches the visual label in the same row).
  z.object({ strategy: z.literal("label-text"), label: z.string() }),
  // Element carrying exact visible text (links, buttons, cells).
  z.object({ strategy: z.literal("text"), text: z.string(), element: z.string().optional() }),
  // Value cell located relative to an anchor label cell (e.g. the cell to
  // the right of "Name:"). The workhorse for reading legacy table screens.
  z.object({ strategy: z.literal("anchor-cell"), anchor: z.string(), direction: z.enum(["right", "below"]) }),
  // Row in a data table identified by the text of one of its cells, then a
  // column offset — for "the balance cell in the Savings row" cases.
  z.object({ strategy: z.literal("table-cell"), rowContains: z.string(), column: z.number().int().min(0) }),
  // Structural CSS path. Brittle; recorded only as a fallback of last resort.
  z.object({ strategy: z.literal("css"), css: z.string() }),
]);
export type LocatorCandidate = z.infer<typeof LocatorCandidate>;

export const Target = z.object({
  description: z.string(), // human-readable: "the Member Number input"
  frame: z.string().default("main"), // frame name path ("top" = no frame)
  candidates: z.array(LocatorCandidate).min(1),
  reasoning: z.string(), // why these candidates, in this order
});
export type Target = z.infer<typeof Target>;

// ---------------------------------------------------------------- detectors
//
// Runtime-condition detectors: the error taxonomy lives here. Each detector
// recognizes a page condition and classifies it. Detectors are checked after
// every step (and on step failure) so replay reacts deliberately instead of
// blindly proceeding.

export const ConditionClass = z.enum([
  "business_outcome", // legitimate result the caller needs (not a crash)
  "recoverable",      // known condition with a scripted recovery
  "hard_failure",     // stop; surface a debuggable error
]);
export type ConditionClass = z.infer<typeof ConditionClass>;

export const Recovery = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("click"), target: Target, maxAttempts: z.number().int().default(1) }),
  z.object({ kind: z.literal("rerun-steps"), fromStep: z.string(), maxAttempts: z.number().int().default(1) }),
  z.object({ kind: z.literal("retry-step"), delayMs: z.number().int(), maxAttempts: z.number().int().default(2) }),
]);
export type Recovery = z.infer<typeof Recovery>;

export const Detector = z.object({
  id: z.string(),
  when: z.object({
    frame: z.string().default("main"),
    textMatches: z.string(), // regex over the frame's visible text
  }),
  classify: ConditionClass,
  outcomeCode: z.string(), // e.g. MEMBER_NOT_FOUND, SESSION_EXPIRED
  message: z.string(),
  recovery: Recovery.optional(), // required when classify === "recoverable"
});
export type Detector = z.infer<typeof Detector>;

// ------------------------------------------------------------------- steps

const StepBase = {
  id: z.string(),
  note: z.string().optional(),
  // risk class drives guardrails: "reversible" runs freely; "risky" is
  // blocked in unattended replay unless the caller passes --approve-risky,
  // otherwise it escalates to a human.
  risk: z.enum(["reversible", "risky"]).default("reversible"),
};

export const Step = z.discriminatedUnion("action", [
  z.object({ ...StepBase, action: z.literal("navigate"), url: z.string() }),
  z.object({ ...StepBase, action: z.literal("click"), target: Target }),
  z.object({
    ...StepBase,
    action: z.literal("fill"),
    target: Target,
    // Either a literal or "{{param}}". Secret params are redacted everywhere.
    value: z.string(),
  }),
  z.object({
    ...StepBase,
    action: z.literal("extract"),
    target: Target,
    output: z.string(), // name of the declared output this fills
  }),
  z.object({
    ...StepBase,
    action: z.literal("assert"),
    target: Target.optional(),
    textMatches: z.string(), // checkpoint condition over target / frame text
    frame: z.string().default("main"),
  }),
]);
export type Step = z.infer<typeof Step>;

// ---------------------------------------------------------------- artifact

export const ParamSpec = z.object({
  name: z.string(),
  type: z.enum(["string", "number"]),
  description: z.string(),
  required: z.boolean().default(true),
  // secret params (credentials) are supplied at invocation from env/vault,
  // never stored in the artifact and always redacted in logs/evidence.
  secret: z.boolean().default(false),
  pattern: z.string().optional(), // input validation regex
});
export type ParamSpec = z.infer<typeof ParamSpec>;

export const OutputSpec = z.object({
  name: z.string(),
  type: z.enum(["string", "money", "date"]),
  description: z.string(),
});
export type OutputSpec = z.infer<typeof OutputSpec>;

export const CapabilityArtifact = z.object({
  schemaVersion: z.literal("1.0"),
  capability: z.object({
    id: z.string(), // kebab-case stable id, e.g. "lookup-member-balance"
    version: z.string(), // semver of this recording
    title: z.string(),
    description: z.string(),
    approvalState: z.enum(["draft", "approved"]).default("draft"),
  }),
  // Where this recording is valid. app+appVersion identify the vendor
  // product; tenant overlays would specialize `entryUrl` and locator
  // candidates per institution (see REPORT.md §4) — the base recording
  // stays tenant-neutral.
  surface: z.object({
    kind: z.enum(["web"]), // extension point: "desktop" | "legacy-web"
    app: z.string(),
    appVersion: z.string().optional(),
    entryUrl: z.string(),
  }),
  inputs: z.array(ParamSpec),
  outputs: z.array(OutputSpec),
  steps: z.array(Step).min(1),
  // Detectors apply flow-wide; step-level failures consult them first.
  detectors: z.array(Detector),
  // Final checkpoint: the state that must hold for the run to be "success".
  successCheckpoint: z.object({
    frame: z.string().default("main"),
    textMatches: z.string(),
    description: z.string(),
  }),
  provenance: z.object({
    recordedAt: z.string(),
    recordedBy: z.string(), // model id or "human"
    discoveryRunId: z.string(),
    goal: z.string(),
  }),
});
export type CapabilityArtifact = z.infer<typeof CapabilityArtifact>;

// ------------------------------------------------------------ result contract
//
// What an invoking agent gets back. Four terminal statuses — success and
// business_outcome are both NORMAL completions; the caller branches on
// outcomeCode. escalated means a human finished/aborted it. hard_failure
// carries debugging detail (step, expected, observed, evidence paths).

export const RunResult = z.object({
  status: z.enum(["success", "business_outcome", "escalated", "hard_failure"]),
  capabilityId: z.string(),
  runId: z.string(),
  outcomeCode: z.string().optional(), // set for business_outcome
  outputs: z.record(z.string(), z.string()).optional(), // set for success
  failure: z
    .object({
      stepId: z.string().optional(),
      expected: z.string(),
      observed: z.string(),
    })
    .optional(),
  escalation: z
    .object({ interventionId: z.string(), resolution: z.string() })
    .optional(),
  evidenceDir: z.string(),
  durationMs: z.number(),
});
export type RunResult = z.infer<typeof RunResult>;

// -------------------------------------------------------------- escalation

export const InterventionRequest = z.object({
  id: z.string(),
  raisedAt: z.string(),
  runId: z.string(),
  mode: z.enum(["discovery", "replay"]),
  capabilityId: z.string().optional(),
  goal: z.string(),
  stepId: z.string().optional(),
  reason: z.string(),
  screenshot: z.string().optional(), // path in evidence dir
  currentUrl: z.string().optional(),
});
export type InterventionRequest = z.infer<typeof InterventionRequest>;

// Control-transfer ledger: exactly one controller at any time.
export const ControlState = z.object({
  controller: z.enum(["agent", "human"]),
  interventionId: z.string().optional(),
  entries: z.array(
    z.object({
      at: z.string(),
      from: z.enum(["agent", "human"]),
      to: z.enum(["agent", "human"]),
      reason: z.string(),
    })
  ),
});
export type ControlState = z.infer<typeof ControlState>;
