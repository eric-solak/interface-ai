# Evidence index

Each directory is one run: `log.jsonl` (structured what/why log), screenshots,
and for replays a `result.json` (the exact result contract the caller gets).
Secrets are redacted everywhere by construction — grep these files for the demo
credentials and you will find nothing.

All runs below are against `artifacts/member-savings-lookup.v1.0.0.json`.

| Run | What it demonstrates | Result |
|---|---|---|
| `discovery-run/` | **Genuine LLM-driven discovery** (`gemini-3.1-flash-lite`, free tier; see `log.jsonl` + redacted `model-transcript.json`): signs in, dismisses the maintenance interstitial, navigates the frameset, searches, extracts the balance, records the artifact | artifact saved (`artifact-copy.json`) |
| `replay-1-success/` | Deterministic replay, no LLM in the loop | `success`, `{savings_balance: "$4,982.17"}` |
| `replay-2-not-found/` | Expected business outcome, not a crash (member 99999) | `business_outcome / MEMBER_NOT_FOUND` |
| `replay-3-permission-denied/` | Second business outcome (restricted record 66600) | `business_outcome / PERMISSION_DENIED` |
| `replay-4-invalid-input/` | Typed-input validation **before any UI action**: `member_id=abc` against the recorded pattern | `hard_failure`, 0 ms, browser never touched |
| `replay-5-session-expiry-recovery/` | Recoverable condition: session killed mid-flow → detector → scripted re-login from s1 → completes | `success` after recovery |
| `replay-6-server-error-hard-failure/` | Injected HTTP 500: bounded recovery attempts, then a clean, debuggable hard failure + screenshot | `hard_failure` with step/expected/observed |
| `replay-7-escalation-handoff/` | Doctored locator (simulated drift) → unexplained step failure → **intervention raised with context + screenshot → control ceded to human on the live session → operator CLI hands control back → run resumes** | resumed; completed `business_outcome` |

Note on `replay-7`: this is a scripted demonstration, so no human actually
typed into the live browser window during the handoff; the run therefore
resumed past the member-number fill and legitimately returned
`MEMBER_NOT_FOUND` for the empty search. The mechanism being evidenced —
detect stuck → route intervention with context → pause → cede the live
session → resume → audit trail (see the `escalation.*` events in `log.jsonl`
and the control ledger) — is fully real. Run it interactively with `--headed`
to perform the manual step yourself and get `success`.
