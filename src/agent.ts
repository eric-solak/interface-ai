// Discovery: the LLM-driven observe -> decide -> act loop, plus the recorder
// that turns a successful run into a CapabilityArtifact.
//
// Design note — recording is dogfooded: when the LLM picks an element, the
// recorder builds the ranked locator candidates for it and the agent EXECUTES
// through the same resolve() cascade replay will use. If the recorded
// locators wouldn't survive replay, discovery fails right there, not next
// week in production.

import fs from "node:fs";
import path from "node:path";
import {
  CapabilityArtifact,
  type Detector,
  type OutputSpec,
  type Step,
  type Target,
} from "./types.js";
import type { WebSurface, UiNode } from "./surface.js";
import type { Llm, Decision } from "./llm.js";
import { Policy, Redactor } from "./policy.js";
import { Evidence } from "./evidence.js";
import { escalate } from "./escalate.js";

export interface DiscoverOptions {
  goal: string;
  entryUrl: string;
  params: Record<string, string>;
  secretParams: Set<string>;
  runId: string;
}

export async function discover(
  surface: WebSurface,
  llm: Llm,
  policy: Policy,
  redactor: Redactor,
  evidence: Evidence,
  opts: DiscoverOptions
): Promise<{ artifactPath: string }> {
  const steps: Step[] = [];
  const outputs: OutputSpec[] = [];
  const history: string[] = [];
  const transcript: unknown[] = [];
  let stepN = 0;
  const nextId = () => `s${++stepN}`;

  // masked view of params for the model: secrets never enter a prompt
  const maskedParams = Object.fromEntries(
    Object.entries(opts.params).map(([k, v]) => [k, opts.secretParams.has(k) ? "<secret>" : v])
  );
  const substitute = (v: string) =>
    v.replace(/\{\{(\w+)\}\}/g, (_, k: string) => opts.params[k] ?? `{{${k}}}`);
  // parameterize literals the model typed verbatim (value -> {{param}})
  const parameterize = (v: string) => {
    for (const [k, pv] of Object.entries(opts.params)) if (v === pv) return `{{${k}}}`;
    return v;
  };

  evidence.log("discovery.start", { goal: opts.goal, entryUrl: opts.entryUrl, llm: llm.id });
  policy.checkNavigation(opts.entryUrl);
  await surface.goto(opts.entryUrl);
  steps.push({ id: nextId(), action: "navigate", url: opts.entryUrl, risk: "reversible", note: "entry point" });
  history.push(`s1: navigate ${opts.entryUrl} -> ok`);

  let lastError: string | undefined;
  let consecutiveFailures = 0;
  let checkpoint: { regex: string; description: string } | undefined;
  // No-progress detection: a step can succeed (no exception) yet make no
  // real progress — e.g. clicking "Sign In" repeatedly on a failed-login
  // page. Track (page state) x (chosen action) fingerprints; the identical
  // pair recurring means the model is looping, independent of whether any
  // individual step throws.
  let prevFingerprint: string | undefined;
  let prevSignature: string | undefined;
  let repeatCount = 0;

  while (true) {
    if (stepN >= policy.cfg.maxStepsPerRun)
      throw new Error(`exceeded maxStepsPerRun (${policy.cfg.maxStepsPerRun}) without reaching the goal`);

    const obs = await surface.observe();
    const nodeList = obs.nodes.map(
      (n, i) => `#${i} [frame:${n.frame}] ${n.role} "${n.name}"${n.value ? ` (value: "${n.value}")` : ""}`
    );
    const ctx = { goal: opts.goal, params: maskedParams, observation: { ...obs, nodeList }, history, lastError };
    lastError = undefined;

    let d: Decision;
    try {
      d = await llm.decide(ctx);
    } catch (e) {
      throw new Error(`LLM decision failed: ${e}`);
    }
    transcript.push({ observation: { url: obs.url, title: obs.title, nodeList }, decision: d });
    evidence.log("discovery.decision", { action: d.action, reason: d.reason });

    const fingerprint = `${obs.url}|${obs.title}|${Object.values(obs.text).join("|")}`;
    const signature = `${d.action}:${d.nodeIndex ?? ""}:${d.value ?? ""}:${d.url ?? ""}`;
    repeatCount = fingerprint === prevFingerprint && signature === prevSignature ? repeatCount + 1 : 0;
    prevFingerprint = fingerprint;
    prevSignature = signature;
    if (repeatCount >= 2 && d.action !== "done" && d.action !== "stuck") {
      evidence.log("discovery.no_progress", { signature, repeats: repeatCount + 1 });
      const { resolution } = await escalate(surface.page, evidence, {
        id: `iv-${Date.now()}`,
        raisedAt: new Date().toISOString(),
        runId: opts.runId,
        mode: "discovery",
        goal: opts.goal,
        reason: `repeated the identical action (${signature}) ${repeatCount + 1} times with no change in page state — likely stuck (e.g. a rejected login or a click that isn't registering)`,
      });
      if (resolution === "ABORT") throw new Error("run aborted by operator during escalation");
      history.push(`escalation: human intervened (${resolution}) after a no-progress loop; resuming discovery`);
      prevFingerprint = prevSignature = undefined;
      repeatCount = 0;
      continue;
    }

    try {
      const pick = (i: number | undefined): UiNode => {
        if (i === undefined || !obs.nodes[i]) throw new Error(`invalid nodeIndex ${i}`);
        return obs.nodes[i];
      };

      if (d.action === "navigate" && d.url) {
        policy.checkActionType("navigate");
        policy.checkNavigation(d.url);
        await surface.goto(d.url);
        const id = nextId();
        steps.push({ id, action: "navigate", url: d.url, risk: "reversible", note: d.reason });
        history.push(`${id}: navigate ${d.url} -> ok`);
      } else if (d.action === "click") {
        policy.checkActionType("click");
        const n = pick(d.nodeIndex);
        const target = targetForNode(n, d.reason);
        const risky = policy.isRiskyControl(n.name);
        const r = await surface.resolve(target, policy.cfg.stepTimeoutMs);
        await r.locator.click();
        const id = nextId();
        steps.push({ id, action: "click", target, risk: risky ? "risky" : "reversible", note: d.reason });
        history.push(`${id}: click ${n.role} "${n.name}" -> ok${risky ? " [RISKY]" : ""}`);
      } else if (d.action === "fill") {
        policy.checkActionType("fill");
        const n = pick(d.nodeIndex);
        if (d.value === undefined) throw new Error("fill without value");
        const recorded = parameterize(d.value);
        const target = targetForNode(n, d.reason);
        const r = await surface.resolve(target, policy.cfg.stepTimeoutMs);
        await r.locator.fill(substitute(d.value));
        const id = nextId();
        steps.push({ id, action: "fill", target, value: recorded, risk: "reversible", note: d.reason });
        history.push(`${id}: fill ${n.role} "${n.name}" = ${recorded} -> ok`);
      } else if (d.action === "extract") {
        policy.checkActionType("extract");
        const ex = d.extract;
        if (!ex) throw new Error("extract without extract spec");
        const target: Target = {
          description: ex.outputDescription,
          frame: ex.frame,
          reasoning: ex.anchor
            ? `value cell anchored to the stable label "${ex.anchor}" — survives cosmetic layout drift`
            : `data-table cell addressed by row text "${ex.rowContains}" + column ${ex.column} — row identity is semantic, column order is the stable part of this screen`,
          candidates: ex.anchor
            ? [{ strategy: "anchor-cell", anchor: ex.anchor, direction: "right" }]
            : [{ strategy: "table-cell", rowContains: ex.rowContains ?? "", column: ex.column ?? 0 }],
        };
        const r = await surface.resolve(target, policy.cfg.stepTimeoutMs);
        const value = (await r.locator.innerText()).trim();
        // mechanical plausibility gate: the model declared what the value
        // should look like; a wrong-cell locator fails HERE, at record time
        const formatOk: Record<string, RegExp> = {
          money: /^[$€£]\s?[\d,]+(\.\d{2})?$|^[\d,]+\.\d{2}$/,
          date: /^\d{4}-\d{2}-\d{2}$|^\d{1,2}\/\d{1,2}\/\d{2,4}$/,
          number: /^-?[\d,]+(\.\d+)?$/,
          text: /^[\s\S]+$/,
        };
        if (!formatOk[ex.expectedFormat]!.test(value))
          throw new Error(
            `extracted value ${JSON.stringify(value)} does not match expectedFormat "${ex.expectedFormat}" for output "${ex.outputName}" — wrong cell? use a different anchor or rowContains+column`
          );
        const id = nextId();
        steps.push({ id, action: "extract", target, output: ex.outputName, risk: "reversible", note: d.reason });
        outputs.push({
          name: ex.outputName,
          type: ex.expectedFormat === "money" ? "money" : ex.expectedFormat === "date" ? "date" : "string",
          description: ex.outputDescription,
        });
        history.push(`${id}: extract ${ex.outputName} = "${value}" -> ok`);
        evidence.log("discovery.extracted", { output: ex.outputName, value });
      } else if (d.action === "done") {
        if (!d.checkpointRegex) throw new Error("done without checkpointRegex");
        const text = await surface.frameText("main");
        if (!new RegExp(d.checkpointRegex).test(text))
          throw new Error(`proposed checkpoint /${d.checkpointRegex}/ does not match the current page`);
        checkpoint = { regex: d.checkpointRegex, description: d.checkpointDescription ?? "goal state reached" };
        history.push(`done: checkpoint verified`);
        break;
      } else if (d.action === "stuck") {
        const { resolution } = await escalate(surface.page, evidence, {
          id: `iv-${Date.now()}`,
          raisedAt: new Date().toISOString(),
          runId: opts.runId,
          mode: "discovery",
          goal: opts.goal,
          reason: d.stuckReason ?? "model reported stuck",
        });
        if (resolution === "ABORT") throw new Error("run aborted by operator during escalation");
        history.push(`escalation: human intervened (${resolution}); resuming discovery`);
        continue;
      } else {
        throw new Error(`malformed decision: ${JSON.stringify(d)}`);
      }
      consecutiveFailures = 0;
    } catch (e) {
      consecutiveFailures++;
      const msg = String(e);
      evidence.log("discovery.action_failed", { reason: msg });
      if (consecutiveFailures >= 3) {
        const { resolution } = await escalate(surface.page, evidence, {
          id: `iv-${Date.now()}`,
          raisedAt: new Date().toISOString(),
          runId: opts.runId,
          mode: "discovery",
          goal: opts.goal,
          reason: `3 consecutive action failures; last: ${msg}`,
        });
        if (resolution === "ABORT") throw new Error("run aborted by operator during escalation");
        consecutiveFailures = 0;
        history.push(`escalation: human intervened (${resolution}); resuming discovery`);
      } else {
        lastError = msg; // feed back to the model; it must choose differently
      }
    }
  }

  // ---------------------------------------------------------- finalize
  const shot = evidence.screenshotPath("final-state.png");
  await surface.screenshot(shot);
  const fin = await llm.finalize(opts.goal, history, maskedParams);
  transcript.push({ finalize: fin });
  evidence.saveFile("model-transcript.json", JSON.stringify(transcript, null, 2));

  const modelDetectors: Detector[] = fin.detectors.map((dt) => ({
    id: dt.id,
    when: { frame: "main", textMatches: dt.textMatches },
    classify: dt.classify,
    outcomeCode: dt.outcomeCode,
    message: dt.message,
    ...(dt.recovery
      ? {
          recovery:
            dt.recovery.kind === "click"
              ? {
                  kind: "click" as const,
                  maxAttempts: 2,
                  target: {
                    description: `dismiss control "${dt.recovery.clickText}"`,
                    frame: "main",
                    reasoning: "recovery control located by its visible text",
                    candidates: [
                      { strategy: "role" as const, role: "button", name: dt.recovery.clickText ?? "" },
                      { strategy: "text" as const, text: dt.recovery.clickText ?? "" },
                    ],
                  },
                }
              : dt.recovery.kind === "rerun-steps"
                ? { kind: "rerun-steps" as const, fromStep: dt.recovery.fromStep ?? "s1", maxAttempts: 1 }
                : { kind: "retry-step" as const, delayMs: dt.recovery.delayMs ?? 3000, maxAttempts: 2 },
        }
      : {}),
  }));
  const detectors = mergeWithDetectorLibrary(modelDetectors);

  // The model may redo an extraction after its self-check (wrong cell first
  // try). Keep only the LAST extract step and output spec per output name.
  const lastExtract = new Map<string, string>(); // output -> stepId
  for (const s of steps) if (s.action === "extract") lastExtract.set(s.output, s.id);
  const prunedSteps = steps.filter((s) => s.action !== "extract" || lastExtract.get(s.output) === s.id);
  const prunedOutputs = [...new Map(outputs.map((o) => [o.name, o])).values()].map(
    (o) => outputs.filter((x) => x.name === o.name).at(-1)!
  );

  const artifact: CapabilityArtifact = CapabilityArtifact.parse({
    schemaVersion: "1.0",
    capability: {
      id: fin.capabilityId,
      version: "1.0.0",
      title: fin.title,
      description: fin.description,
      approvalState: "draft",
    },
    surface: { kind: "web", app: "MFCU Teller Console", appVersion: "2.4.1900", entryUrl: opts.entryUrl },
    inputs: fin.inputs.map((i) => ({
      ...i,
      required: true,
      secret: opts.secretParams.has(i.name),
      // Guarantee a validation pattern for non-secret inputs even when the
      // model omits one: infer a conservative pattern from the observed
      // value's shape. Without this, replay would accept malformed input and
      // let it reach the application.
      pattern: i.pattern ?? (opts.secretParams.has(i.name) ? undefined : inferPattern(opts.params[i.name])),
    })),
    outputs: prunedOutputs,
    steps: prunedSteps,
    detectors,
    successCheckpoint: { frame: "main", textMatches: checkpoint!.regex, description: checkpoint!.description },
    provenance: {
      recordedAt: new Date().toISOString(),
      recordedBy: llm.id,
      discoveryRunId: opts.runId,
      goal: opts.goal,
    },
  });

  fs.mkdirSync("artifacts", { recursive: true });
  const artifactPath = path.join("artifacts", `${artifact.capability.id}.v${artifact.capability.version}.json`);
  fs.writeFileSync(artifactPath, redactor.redact(JSON.stringify(artifact, null, 2)));
  evidence.log("discovery.artifact_saved", { artifactPath, steps: steps.length, detectors: detectors.length });
  evidence.saveFile("artifact-copy.json", JSON.stringify(artifact, null, 2));
  return { artifactPath };
}

// Detectors have three sources: (1) this curated library of generic legacy-app
// error patterns — robust regexes the model cannot know because discovery only
// sees the happy path; (2) the model's app-specific proposals; (3) in
// production, patterns promoted from triaged escalations (see REPORT.md §3).
// Merge rule: when the model proposed the same outcomeCode, its classification
// and recovery win but the library pattern is OR-ed in; otherwise the library
// entry is added with its conservative default.
const DETECTOR_LIBRARY: { outcomeCode: string; pattern: string; d: Omit<Detector, "when"> & { when?: never } }[] = [
  {
    outcomeCode: "SESSION_EXPIRED",
    pattern: "session (has )?(expired|timed out)|logged out due to inactivity",
    d: {
      id: "lib-session-expired",
      classify: "recoverable",
      outcomeCode: "SESSION_EXPIRED",
      message: "Session expired; re-run the flow from the start to re-authenticate.",
      recovery: { kind: "rerun-steps", fromStep: "s1", maxAttempts: 1 },
    },
  },
  {
    outcomeCode: "MEMBER_NOT_FOUND",
    pattern: "no \\w+ (was )?found|not found|no (records?|results?|matches?)( found)?|does not exist",
    d: {
      id: "lib-not-found",
      classify: "business_outcome",
      outcomeCode: "MEMBER_NOT_FOUND",
      message: "The requested record does not exist.",
    },
  },
  {
    outcomeCode: "PERMISSION_DENIED",
    pattern: "(access|permission) (is )?(denied|restricted)|requires (supervisor|manager|admin)|not authorized",
    d: {
      id: "lib-permission-denied",
      classify: "business_outcome",
      outcomeCode: "PERMISSION_DENIED",
      message: "The operator is not authorized for this record or action.",
    },
  },
  {
    outcomeCode: "APP_SERVER_ERROR",
    pattern: "http 50[0-4]|ORA-\\d+|internal (server )?error|unexpected error|contact (it|support)",
    d: {
      id: "lib-server-error",
      classify: "hard_failure",
      outcomeCode: "APP_SERVER_ERROR",
      message: "The application returned a server error.",
    },
  },
];

/** Models sometimes emit non-JS regex syntax (inline flags like `(?i)`).
 *  Strip inline flags (matching is case-insensitive anyway) and drop any
 *  pattern that still fails to compile rather than poisoning the artifact. */
function sanitizePattern(p: string): string | undefined {
  const cleaned = p.replace(/\(\?[a-z]+\)/gi, "");
  try {
    new RegExp(cleaned, "i");
    return cleaned;
  } catch {
    return undefined;
  }
}

function mergeWithDetectorLibrary(model: Detector[]): Detector[] {
  const out: Detector[] = [];
  for (const d of model) {
    const cleaned = sanitizePattern(d.when.textMatches);
    if (cleaned === undefined) {
      console.log(`  [recorder] dropping detector "${d.id}": invalid regex ${JSON.stringify(d.when.textMatches)}`);
      continue;
    }
    out.push({ ...d, when: { ...d.when, textMatches: cleaned } });
  }
  for (const lib of DETECTOR_LIBRARY) {
    const existing = out.find((d) => d.outcomeCode === lib.outcomeCode);
    if (existing) {
      // model classification/recovery wins; library pattern broadens the match
      existing.when.textMatches = `${existing.when.textMatches}|${lib.pattern}`;
    } else {
      out.push({ ...lib.d, when: { frame: "main", textMatches: lib.pattern } });
    }
  }
  return out;
}

/** Conservative validation pattern inferred from the value used at record
 *  time. Deliberately shape-based (digits / alphanumeric-ish), never the
 *  literal value — the artifact must stay reusable for other inputs. */
function inferPattern(sample: string | undefined): string | undefined {
  if (!sample) return undefined;
  if (/^\d+$/.test(sample)) return `^[0-9]{1,${Math.max(sample.length + 4, 10)}}$`;
  if (/^[A-Za-z0-9._-]+$/.test(sample)) return `^[A-Za-z0-9._-]{1,${Math.max(sample.length + 8, 32)}}$`;
  return undefined; // free-form text: no safe generic pattern
}

/** Ranked locator candidates for an element the model picked. */
function targetForNode(n: UiNode, why: string): Target {
  const candidates: Target["candidates"] = [];
  if (n.role === "textbox") {
    if (n.name) candidates.push({ strategy: "label-text", label: n.name });
  } else {
    if (n.name) {
      candidates.push({ strategy: "role", role: n.role === "link" ? "link" : "button", name: n.name });
      candidates.push({ strategy: "text", text: n.name });
    }
  }
  candidates.push({ strategy: "css", css: n.cssPath });
  return {
    description: `${n.role} "${n.name}"`,
    frame: n.frame,
    candidates,
    reasoning:
      `chosen by model: ${why}. Ranked semantic-first: ` +
      (n.role === "textbox"
        ? "label-text survives markup changes in label-less legacy forms; "
        : "accessible role+name survives cosmetic drift; visible text is the human-stable identity; ") +
      "structural CSS recorded only as last resort (its use is flagged as drift).",
  };
}
