# Capability Runner — Computer-Use Automation System

An LLM discovers how to accomplish a goal in a legacy banking UI **once**; the
successful run becomes a typed, versioned **capability artifact**; production
invocations **replay the artifact deterministically** — no model in the loop —
with explicit runtime-error handling, safety guardrails, and a
human-in-the-loop handoff on the live session.

Design rationale, trade-offs, and cut lines: **[REPORT.md](REPORT.md)**.
Demonstration runs: **[/evidence/](evidence/)**.

## Setup

Requires Node 20+.

```bash
npm install
npx playwright install chromium
```

### LLM configuration (discovery only — replay never uses a model)

The default provider is Google AI Studio's **free tier** (free API key, no
card, hard quota — it rate-limits, it never bills). Get a key at
https://aistudio.google.com/apikey and:

```bash
# bash                              # powershell
export GEMINI_API_KEY=...           $env:GEMINI_API_KEY="..."
```

Alternatives:

| Provider | Env |
|---|---|
| Gemini free tier (default) | `GEMINI_API_KEY` (+ optional `LLM_MODEL`, default `gemini-flash-latest`) |
| Any OpenAI-compatible API (Groq, Ollama, …) | `LLM_PROVIDER=openai`, `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` |
| No key at all | automatic **mock** provider — a scripted test fixture so everything runs offline. The committed `/evidence/` discovery run was produced with a real model. |

No other live services are needed: the target application is local.

## Demo path

**Terminal 1 — start the target app** (a deliberately legacy "credit union
teller console": frameset layout, table markup, no test IDs, plus injectable
runtime faults):

```bash
npm run target-app          # http://127.0.0.1:4173  (teller1 / demo-pass)
```

Leave it running. If it reports the port is already in use, an instance is
already up — just continue to the next step, or take the port over with the
command it prints.

**Terminal 2 — discovery run** (LLM drives the UI, records the artifact).
`ARTIFACT` below is `artifacts/member-savings-lookup.v1.0.0.json` —
the capability id the model picks can vary slightly run to run, so check the
`discovery complete -> ...` line it prints and use that path for replay.

```bash
# bash
npm run discover -- --goal "Look up member 12345 and read their current savings balance" \
  --url http://127.0.0.1:4173/ \
  --param member_id=12345 \
  --secret-param operator_id=teller1 --secret-param passcode=demo-pass
```

```powershell
# PowerShell
npm run discover -- --goal "Look up member 12345 and read their current savings balance" `
  --url http://127.0.0.1:4173/ `
  --param member_id=12345 `
  --secret-param operator_id=teller1 --secret-param passcode=demo-pass
```

**Replay the artifact deterministically** (the production path — no LLM):

```bash
npm run replay -- --artifact artifacts/member-savings-lookup.v1.0.0.json --param member_id=12345 --secret-param operator_id=teller1 --secret-param passcode=demo-pass
# -> {"status":"success","outputs":{"savings_balance":"$4,982.17"},...}
```

**Exceptional-state replays** (`$A` = the artifact path, `$S` = the two
`--secret-param` flags above)

```bash
A=artifacts/member-savings-lookup.v1.0.0.json
S="--secret-param operator_id=teller1 --secret-param passcode=demo-pass"

# expected business outcomes:

npm run replay -- --artifact $A --param member_id=99999 $S # {"status":"business_outcome","outcomeCode":"MEMBER_NOT_FOUND"}
npm run replay -- --artifact $A --param member_id=66600 $S # PERMISSION_DENIED

# typed-input validation, before the browser is even touched:
npm run replay -- --artifact $A --param member_id=abc $S # {"status":"hard_failure",...} in 0ms — rejected by the recorded pattern

# recoverable condition (scripted recovery, then success):
npm run replay -- --artifact $A --param member_id=12345 $S --inject expire # session dies mid-flow -> detector -> re-login from s1 -> success

# hard failure (structured, debuggable):
npm run replay -- --artifact $A --param member_id=12345 $S --inject break # {"status":"hard_failure","failure":{...}} + failure screenshot
```

**Human-in-the-loop handoff** (best experienced headed):

```bash
npm run replay -- --artifact $A --param member_id=12345 $S --headed # if a step gets stuck -> intervention is raised, the browser window stays open, control cedes to human

npm run operator # terminal 3: review, act in the live window, enter a resolution note -> control returns, the run resumes
```

Replay flags: `--headed`, `--approve-risky` (pre-approve risky/irreversible
steps; otherwise they escalate), `--no-escalate` (fail fast instead of
escalating), `--inject slow|break|expire` (target-app fault injection).

Exit codes: `0` success / business outcome · `2` hard failure · `3` aborted by
operator.

## Layout

```
src/types.ts      artifact schema, result contract, escalation types (zod)
src/agent.ts      LLM discovery loop + artifact recorder
src/replay.ts     deterministic replay engine + error taxonomy
src/surface.ts    surface abstraction (Playwright web impl, locator cascade)
src/llm.ts        provider seam: gemini | openai-compatible | mock
src/policy.ts     allowlist, risk classes, redaction     (config: policy.json)
src/escalate.ts   intervention requests, control ledger, operator CLI
src/evidence.ts   per-run JSONL logs + screenshots
target-app/       local legacy bank console (the proxy target) + fault flags
artifacts/        recorded capabilities
evidence/         demonstration runs (discovery + replays)
```

## Notes

- Demo credentials (`teller1` / `demo-pass`) are for the bundled local demo
  app only. Secret params are never persisted in artifacts, logs, or evidence
  (see redaction in `src/policy.ts`).
- The target app is local and self-owned; nothing is automated against
  third-party services.
