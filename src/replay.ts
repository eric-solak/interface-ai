// Deterministic replay: execute a CapabilityArtifact with NO model in the
// loop. The path an AI agent triggers in production.
//
// Error taxonomy at runtime (checked after navigation/steps and on any step
// failure):
//   business_outcome -> normal completion; caller branches on outcomeCode
//   recoverable      -> scripted recovery (dismiss / re-run prelude / wait+retry)
//                       with hard attempt caps, then the step is retried
//   hard_failure     -> stop; structured, debuggable error + screenshot;
//                       optionally escalate to a human on the live session
//
// Determinism comes from: pinned artifact + validated inputs, single-match
// locator resolution (ambiguity is failure, never a coin flip), bounded
// explicit waits (no sleeps in the happy path), checkpoint verification, and
// capped recovery loops.

import fs from "node:fs";
import {
  CapabilityArtifact,
  type Detector,
  type RunResult,
  type Step,
} from "./types.js";
import type { WebSurface } from "./surface.js";
import { Policy, PolicyViolation, Redactor } from "./policy.js";
import type { Evidence } from "./evidence.js";
import { escalate } from "./escalate.js";

export interface ReplayOptions {
  params: Record<string, string>;
  runId: string;
  approveRisky: boolean; // caller pre-approved risky steps
  escalateOnFailure: boolean; // hand hard failures to a human vs fail fast
}

export function loadArtifact(p: string): CapabilityArtifact {
  return CapabilityArtifact.parse(JSON.parse(fs.readFileSync(p, "utf8")));
}

export async function replay(
  artifact: CapabilityArtifact,
  surface: WebSurface,
  policy: Policy,
  redactor: Redactor,
  evidence: Evidence,
  opts: ReplayOptions
): Promise<RunResult> {
  const t0 = Date.now();
  const outputs: Record<string, string> = {};
  const recoveryAttempts = new Map<string, number>();
  const base = {
    capabilityId: artifact.capability.id,
    runId: opts.runId,
    evidenceDir: evidence.dir,
  };
  const finish = (r: Omit<RunResult, "capabilityId" | "runId" | "evidenceDir" | "durationMs">): RunResult => {
    const result = { ...base, ...r, durationMs: Date.now() - t0 };
    evidence.log("replay.result", { status: result.status, outcomeCode: result.outcomeCode });
    evidence.saveFile("result.json", JSON.stringify(result, null, 2));
    return result;
  };

  // ---- input validation (before touching the surface) --------------------
  for (const spec of artifact.inputs) {
    const v = opts.params[spec.name];
    if (v === undefined && spec.required)
      return finish({
        status: "hard_failure",
        failure: { expected: `required input "${spec.name}"`, observed: "missing" },
      });
    // The declared TYPE is enforced, not just the optional pattern — an
    // artifact whose recording model omitted a pattern must still reject
    // structurally wrong input before any UI action is taken.
    if (v !== undefined && spec.type === "number" && !/^-?\d+(\.\d+)?$/.test(v.trim()))
      return finish({
        status: "hard_failure",
        failure: {
          expected: `input "${spec.name}" of declared type number`,
          observed: spec.secret ? "[REDACTED]" : `"${v}"`,
        },
      });
    if (v !== undefined && spec.pattern && !new RegExp(spec.pattern).test(v))
      return finish({
        status: "hard_failure",
        failure: {
          expected: `input "${spec.name}" matching /${spec.pattern}/`,
          observed: spec.secret ? "[REDACTED]" : `"${v}"`,
        },
      });
    if (v !== undefined && spec.secret) redactor.addSecret(v);
  }

  evidence.log("replay.start", {
    capability: `${artifact.capability.id}@${artifact.capability.version}`,
    approvalState: artifact.capability.approvalState,
  });

  const substitute = (v: string) => v.replace(/\{\{(\w+)\}\}/g, (_, k: string) => opts.params[k] ?? "");

  // ---- detector scan ------------------------------------------------------
  type Hit = { detector: Detector };
  const scanDetectors = async (): Promise<Hit | undefined> => {
    await surface.settle(); // read post-navigation state, not the page we left
    for (const d of artifact.detectors) {
      let re: RegExp;
      try {
        re = new RegExp(d.when.textMatches, "i");
      } catch {
        evidence.log("replay.detector_invalid", { detectorId: d.id, pattern: d.when.textMatches });
        continue; // a broken detector must not kill the run
      }
      const text = await surface.frameText(d.when.frame);
      if (re.test(text)) return { detector: d };
    }
    return undefined;
  };

  const steps = artifact.steps;
  let i = 0;
  while (i < steps.length) {
    const step = steps[i]!;

    // ---- guardrails ------------------------------------------------------
    try {
      policy.checkActionType(step.action);
      if (step.action === "navigate") policy.checkNavigation(step.url);
    } catch (e) {
      if (e instanceof PolicyViolation)
        return finish({ status: "hard_failure", failure: { stepId: step.id, expected: "action inside policy allowlist", observed: e.message } });
      throw e;
    }
    if (step.risk === "risky" && !opts.approveRisky) {
      evidence.log("replay.risky_blocked", { stepId: step.id });
      // Unattended invocation (--no-escalate): there is no operator to wait
      // for, so the run must terminate with a result rather than block
      // forever. The step is still refused — blocking is the safe default.
      if (!opts.escalateOnFailure)
        return finish({
          status: "hard_failure",
          failure: {
            stepId: step.id,
            expected: `approval for risky/irreversible step "${step.id}"`,
            observed:
              "step is classified risky and the run is unattended (--no-escalate); re-invoke with --approve-risky or allow escalation",
          },
        });
      const { resolution } = await escalate(surface.page, evidence, {
        id: `iv-${Date.now()}`,
        raisedAt: new Date().toISOString(),
        runId: opts.runId,
        mode: "replay",
        capabilityId: artifact.capability.id,
        goal: artifact.provenance.goal,
        stepId: step.id,
        reason: `risky/irreversible step "${step.id}" requires human approval (invoke with --approve-risky to pre-approve)`,
      });
      if (resolution === "ABORT")
        return finish({
          status: "escalated",
          escalation: { interventionId: "risky-approval", resolution: "aborted by operator" },
        });
      // human either performed the step or approved continuing; skip to next
      i++;
      continue;
    }

    // ---- execute with detector-aware failure handling --------------------
    try {
      await executeStep(step, surface, policy, substitute, outputs, evidence);
      evidence.log("replay.step_ok", { stepId: step.id, action: step.action });
      i++;
      // Post-step scan handles TERMINAL conditions only (business outcomes,
      // hard failures). Recoverable conditions are deliberately not recovered
      // here: when the recorded flow expects one (e.g. a dismissal step), the
      // next step handles it; when unexpected, the next step fails and the
      // failure path below runs the scripted recovery, then retries. This
      // keeps one owner per condition and avoids double-dismissal races.
      const hit = await scanDetectors();
      if (hit && hit.detector.classify !== "recoverable") {
        const handled = await handleDetector(hit.detector);
        if (handled) return handled;
      }
    } catch (err) {
      const hit = await scanDetectors();
      if (hit) {
        // the failure is explained by a recognized condition
        const handled = await handleDetector(hit.detector, step);
        if (handled) return handled;
        continue; // recovered -> retry the same step
      }
      // unexplained -> hard failure path
      const shot = evidence.screenshotPath(`failure-${step.id}.png`);
      await surface.screenshot(shot).catch(() => {});
      evidence.log("replay.step_failed", { stepId: step.id, reason: String(err), screenshot: shot });
      if (opts.escalateOnFailure) {
        const { resolution } = await escalate(surface.page, evidence, {
          id: `iv-${Date.now()}`,
          raisedAt: new Date().toISOString(),
          runId: opts.runId,
          mode: "replay",
          capabilityId: artifact.capability.id,
          goal: artifact.provenance.goal,
          stepId: step.id,
          reason: `step failed and no detector explains the state: ${String(err).slice(0, 300)}`,
        });
        if (resolution !== "ABORT") {
          i++; // assume the human completed this step manually; continue after it
          continue;
        }
        return finish({ status: "escalated", escalation: { interventionId: "step-failure", resolution } });
      }
      return finish({
        status: "hard_failure",
        failure: {
          stepId: step.id,
          expected: describeExpectation(step),
          observed: String(err),
        },
      });
    }
  }

  // ---- success checkpoint -------------------------------------------------
  const cp = artifact.successCheckpoint;
  const finalText = await surface.frameText(cp.frame);
  if (!new RegExp(cp.textMatches).test(finalText)) {
    const shot = evidence.screenshotPath("failure-checkpoint.png");
    await surface.screenshot(shot).catch(() => {});
    return finish({
      status: "hard_failure",
      failure: {
        expected: `success checkpoint: ${cp.description} (/${cp.textMatches}/)`,
        observed: `page text: ${finalText.slice(0, 300)}`,
      },
    });
  }
  await surface.screenshot(evidence.screenshotPath("final-state.png")).catch(() => {});
  return finish({ status: "success", outputs });

  // ---- detector handling (shared by post-step scan and failure path) -----
  async function handleDetector(d: Detector, failedStep?: Step): Promise<RunResult | undefined> {
    evidence.log("replay.condition_detected", {
      detectorId: d.id,
      classify: d.classify,
      outcomeCode: d.outcomeCode,
    });
    if (d.classify === "business_outcome") {
      await surface.screenshot(evidence.screenshotPath(`outcome-${d.outcomeCode}.png`)).catch(() => {});
      return finish({ status: "business_outcome", outcomeCode: d.outcomeCode });
    }
    if (d.classify === "hard_failure") {
      const shot = evidence.screenshotPath(`failure-${d.outcomeCode}.png`);
      await surface.screenshot(shot).catch(() => {});
      return finish({
        status: "hard_failure",
        failure: { stepId: failedStep?.id, expected: "normal application state", observed: d.message },
      });
    }
    // recoverable
    const n = (recoveryAttempts.get(d.id) ?? 0) + 1;
    recoveryAttempts.set(d.id, n);
    const rec = d.recovery;
    if (!rec || n > rec.maxAttempts) {
      await surface.screenshot(evidence.screenshotPath(`failure-${d.outcomeCode}.png`)).catch(() => {});
      return finish({
        status: "hard_failure",
        failure: {
          stepId: failedStep?.id,
          expected: `recovery "${d.id}" to succeed within ${rec?.maxAttempts ?? 0} attempts`,
          observed: d.message,
        },
      });
    }
    evidence.log("replay.recovery", { detectorId: d.id, kind: rec.kind, attempt: n });
    if (rec.kind === "click") {
      const r = await surface.resolve(rec.target, policy.cfg.stepTimeoutMs);
      await r.locator.click({ timeout: policy.cfg.stepTimeoutMs });
    } else if (rec.kind === "rerun-steps") {
      const idx = steps.findIndex((s) => s.id === rec.fromStep);
      if (idx < 0)
        return finish({
          status: "hard_failure",
          failure: { expected: `recovery fromStep "${rec.fromStep}" to exist`, observed: "not found in steps" },
        });
      i = idx; // jump back; loop re-executes the prelude
    } else {
      await new Promise((r) => setTimeout(r, rec.delayMs));
    }
    return undefined; // recovered (or repositioned) -> caller continues
  }
}

async function executeStep(
  step: Step,
  surface: WebSurface,
  policy: Policy,
  substitute: (v: string) => string,
  outputs: Record<string, string>,
  evidence: Evidence
): Promise<void> {
  const t = policy.cfg.stepTimeoutMs;
  switch (step.action) {
    case "navigate":
      await surface.goto(step.url);
      return;
    case "click": {
      const r = await surface.resolve(step.target, t);
      driftWarn(step, r.candidateIndex, r.strategy, evidence);
      await r.locator.click({ timeout: t });
      return;
    }
    case "fill": {
      const r = await surface.resolve(step.target, t);
      driftWarn(step, r.candidateIndex, r.strategy, evidence);
      await r.locator.fill(substitute(step.value), { timeout: t });
      return;
    }
    case "extract": {
      const r = await surface.resolve(step.target, t);
      outputs[step.output] = (await r.locator.innerText()).trim();
      return;
    }
    case "assert": {
      const text = await surface.frameText(step.frame);
      if (!new RegExp(step.textMatches).test(text))
        throw new Error(`assertion /${step.textMatches}/ did not match frame "${step.frame}"`);
      return;
    }
  }
}

function driftWarn(step: Step, candidateIndex: number, strategy: string, evidence: Evidence): void {
  if (candidateIndex > 0 || strategy === "css")
    evidence.log("replay.drift_warning", {
      stepId: step.id,
      resolvedBy: strategy,
      candidateIndex,
      note: "primary locator no longer matches — review artifact against current app version",
    });
}

function describeExpectation(step: Step): string {
  switch (step.action) {
    case "navigate":
      return `navigation to ${step.url}`;
    case "click":
    case "fill":
    case "extract":
      return `exactly one visible match for "${step.target.description}" in frame "${step.target.frame}"`;
    case "assert":
      return `frame "${step.frame}" text matching /${step.textMatches}/`;
  }
}
