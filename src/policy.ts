// Safety & policy guardrails: allowlist enforcement + risk classes + redaction.
//
// The policy is DATA (policy.json), not code, so it is reviewable and
// per-deployment configurable. Every action — discovery or replay — passes
// through Policy.checkNavigation / checkAction before it touches the surface.

import fs from "node:fs";
import { z } from "zod";

const PolicyFile = z.object({
  allowedOrigins: z.array(z.string()), // exact origins the agent may touch
  allowedActions: z.array(z.enum(["navigate", "click", "fill", "extract", "assert"])),
  // Substrings of button/link accessible names that mark an action risky/
  // irreversible (submit-money, delete, close-account...). Risky actions are
  // blocked unattended: they require --approve-risky or human escalation.
  riskyActionNames: z.array(z.string()),
  maxStepsPerRun: z.number().int(),
  stepTimeoutMs: z.number().int(),
});
export type PolicyConfig = z.infer<typeof PolicyFile>;

export class PolicyViolation extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "PolicyViolation";
  }
}

export class Policy {
  constructor(readonly cfg: PolicyConfig) {}

  static load(path = "policy.json"): Policy {
    return new Policy(PolicyFile.parse(JSON.parse(fs.readFileSync(path, "utf8"))));
  }

  checkNavigation(url: string): void {
    const origin = new URL(url).origin;
    if (!this.cfg.allowedOrigins.includes(origin))
      throw new PolicyViolation(`navigation to ${origin} is outside the allowlist`);
  }

  checkActionType(action: string): void {
    if (!this.cfg.allowedActions.includes(action as never))
      throw new PolicyViolation(`action type "${action}" is not allowlisted`);
  }

  /** Risk classification by the accessible name of the control being activated. */
  isRiskyControl(accessibleName: string): boolean {
    const n = accessibleName.toLowerCase();
    return this.cfg.riskyActionNames.some((r) => n.includes(r.toLowerCase()));
  }
}

// ------------------------------------------------------------------ redaction
//
// Secrets never reach artifacts or evidence. Redaction is centralized: the
// evidence logger and the artifact recorder both pass text through here with
// the set of currently-known secret values.

export class Redactor {
  private secrets: string[] = [];

  addSecret(value: string): void {
    if (value && value.length >= 4) this.secrets.push(value);
  }

  redact(text: string): string {
    let out = text;
    for (const s of this.secrets) out = out.split(s).join("[REDACTED]");
    return out;
  }

  redactDeep<T>(obj: T): T {
    return JSON.parse(this.redact(JSON.stringify(obj))) as T;
  }
}
