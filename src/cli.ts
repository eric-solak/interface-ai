// CLI entrypoints.
//
//   discover  --goal "..." --url http://... --param k=v --secret-param k=v [--headed]
//   replay    --artifact artifacts/x.json --param k=v --secret-param k=v
//             [--headed] [--approve-risky] [--no-escalate] [--inject slow|break|expire]
//   operator  (reviews a pending intervention and hands control back)
//
// Exit codes: 0 success/business_outcome, 2 hard_failure, 3 escalated-aborted.

import { discover } from "./agent.js";
import { replay, loadArtifact } from "./replay.js";
import { WebSurface } from "./surface.js";
import { loadLlm } from "./llm.js";
import { Policy, Redactor } from "./policy.js";
import { Evidence, newRunId } from "./evidence.js";
import { operatorCli, transferControl } from "./escalate.js";

interface Args {
  cmd: string;
  flags: Map<string, string | true>;
  params: Record<string, string>;
  secretParams: Record<string, string>;
}

/**
 * Every token must be consumed by a recognized flag. A stray token (most
 * often an unquoted multi-word --goal, or a shell-specific line-continuation
 * character like bash's trailing "\" that PowerShell doesn't understand)
 * previously got silently dropped, which could truncate --goal or corrupt a
 * value (e.g. a bare "#" glued onto a password) with no visible error. Fail
 * loudly instead: this is a CLI meant to run unattended in production.
 */
function parseArgs(argv: string[]): Args {
  const [cmd = "help", ...rest] = argv;
  const flags = new Map<string, string | true>();
  const params: Record<string, string> = {};
  const secretParams: Record<string, string> = {};
  const stray: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--param" || a === "--secret-param") {
      const kv = rest[++i];
      const eq = kv?.indexOf("=") ?? -1;
      if (kv === undefined || eq < 0) throw new Error(`${a} expects key=value, got ${JSON.stringify(kv)}`);
      (a === "--param" ? params : secretParams)[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a.startsWith("--")) {
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(a.slice(2), next);
        i++;
      } else flags.set(a.slice(2), true);
    } else {
      stray.push(a);
    }
  }
  if (stray.length > 0)
    throw new Error(
      `unrecognized argument(s): ${stray.map((s) => JSON.stringify(s)).join(", ")}. ` +
        `Every multi-word value (e.g. --goal) must be one quoted string. ` +
        `In PowerShell, use backtick (\`) for line continuation, not backslash — ` +
        `or just quote each flag value on a single line: --goal "..." --url "..." --param k=v`
    );
  return { cmd, flags, params, secretParams };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.cmd === "operator") {
    await operatorCli();
    return 0;
  }
  if (args.cmd !== "discover" && args.cmd !== "replay") {
    console.log("usage: cli.ts discover|replay|operator [options] — see README.md");
    return 1;
  }

  const policy = Policy.load();
  const redactor = new Redactor();
  const allParams = { ...args.params, ...args.secretParams };
  for (const v of Object.values(args.secretParams)) redactor.addSecret(v);
  const runId = newRunId();
  const headed = args.flags.has("headed");
  transferControl("agent", `run ${runId} starting`);

  const surface = await WebSurface.launch({ headed });
  try {
    if (args.cmd === "discover") {
      const goal = args.flags.get("goal");
      const url = args.flags.get("url");
      if (typeof goal !== "string" || typeof url !== "string")
        throw new Error("discover requires --goal and --url");
      const evidence = new Evidence(runId, "discovery", redactor);
      const llm = loadLlm();
      const { artifactPath } = await discover(surface, llm, policy, redactor, evidence, {
        goal,
        entryUrl: url,
        params: allParams,
        secretParams: new Set(Object.keys(args.secretParams)),
        runId,
      });
      console.log(`\ndiscovery complete -> ${artifactPath}`);
      console.log(`evidence           -> ${evidence.dir}`);
      return 0;
    }

    // replay
    const artifactFlag = args.flags.get("artifact");
    if (typeof artifactFlag !== "string") throw new Error("replay requires --artifact <path>");
    const artifact = loadArtifact(artifactFlag);
    const evidence = new Evidence(runId, "replay", redactor);

    // fault injection for demonstration replays (drives the target app's flags)
    const inject = args.flags.get("inject");
    if (inject === "slow" || inject === "break") {
      await fetch(`${new URL(artifact.surface.entryUrl).origin}/main/results?${inject}=1`, { method: "GET" }).catch(() => {});
      evidence.log("replay.fault_injected", { inject });
    } else if (typeof inject === "string" && inject.startsWith("expire")) {
      // arm a one-shot session expiry that fires mid-flow; "expire:N" sets
      // how many authenticated requests survive before the session dies
      const after = Number(inject.split(":")[1] ?? 4);
      await fetch(`${new URL(artifact.surface.entryUrl).origin}/?expire_after=${after}`).catch(() => {});
      evidence.log("replay.fault_injected", { inject: `expire (session dies after ${after} requests)` });
    }

    const result = await replay(artifact, surface, policy, redactor, evidence, {
      params: allParams,
      runId,
      approveRisky: args.flags.has("approve-risky"),
      escalateOnFailure: !args.flags.has("no-escalate"),
    });
    console.log("\n" + JSON.stringify(result, null, 2));
    return result.status === "success" || result.status === "business_outcome" ? 0 : result.status === "hard_failure" ? 2 : 3;
  } finally {
    await surface.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`\nfatal: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  });
