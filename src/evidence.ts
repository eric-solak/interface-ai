// Evidence / observability: every run gets its own directory containing a
// structured JSONL log (what happened and why), screenshots on failure and
// at key moments, and — for discovery — the raw model transcript (redacted).

import fs from "node:fs";
import path from "node:path";
import { Redactor } from "./policy.js";

export class Evidence {
  readonly dir: string;
  private logPath: string;

  constructor(
    readonly runId: string,
    kind: "discovery" | "replay",
    private redactor: Redactor
  ) {
    this.dir = path.join("evidence", `${kind}-${runId}`);
    fs.mkdirSync(this.dir, { recursive: true });
    this.logPath = path.join(this.dir, "log.jsonl");
  }

  log(event: string, data: Record<string, unknown> = {}): void {
    const line = this.redactor.redact(
      JSON.stringify({ at: new Date().toISOString(), event, ...data })
    );
    fs.appendFileSync(this.logPath, line + "\n");
    // concise console mirror
    const extra = data["stepId"] ?? data["reason"] ?? data["outcomeCode"] ?? data["url"] ?? "";
    console.log(`  [${event}] ${String(extra)}`.trimEnd());
  }

  saveFile(name: string, content: string): string {
    const p = path.join(this.dir, name);
    fs.writeFileSync(p, this.redactor.redact(content));
    return p;
  }

  screenshotPath(name: string): string {
    return path.join(this.dir, name);
  }
}

export function newRunId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}
