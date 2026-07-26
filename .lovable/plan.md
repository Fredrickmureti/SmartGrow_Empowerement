## What is actually happening (verified against the live database)

Your instinct is right: the pairing step is fast because it never touches the printer, and everything after it hangs because **no job has ever reached the workstation**.

Evidence from the project database, not inference:

- `edge_jobs`: **71 rows, 71 `queued`, 0 `in_progress`, 0 `done`, 0 `error`, 0 `expired`**, spanning 06:09 → 07:04. `claimed_at` is `NULL` on every single row, including your `test` jobs (`{"port":9100,"ipAddress":"127.0.0.1"}`) and your ZPL `print` jobs. The browser enqueues correctly; the agent has never claimed anything.
- `workstations` (only row, "back office-label printer"): `last_seen_at = 06:33:52`, `secret_rotated_at = 06:34:02`. `last_seen_at` is written on **every successful** agent poll (`supabase/functions/edge/routes/agent-poll.ts:16`), and the agent polls every 1.5s (`agent/src/relay.ts:53`). So the agent's cloud calls started failing ~10 seconds after the credential was rotated, and have failed ever since.
- `workstation_devices`: single row `tcp:127.0.0.1:9100`, `updated_at = 06:33:28` — the capability manifest publisher (60s interval) also went silent at the same moment, from the same credential.
- `edge_jobs` and `workstation_devices` are both in the `supabase_realtime` publication, so the browser's wait path is not the problem.

### Why each symptom looks the way it does

1. **"Agent v1.3.0-edge.p3 authorized (10 devices discovered)" is instant** because that step does not do a round trip to the workstation. It reads the *already-published* manifest/device rows in the cloud plus a local probe. Stale cloud state is being reported as live authorization.
2. **"Printer is online"** is the same illusion: it came from the cached `workstation_devices` row (`health: ok`, written at 06:33), not from a live TCP check.
3. **"Loading forever, no console errors"**: `RelayTransport` waits `deadlineMs + 2s` (45s + 2s, `RelayTransport.ts:56`), and `edge_jobs_expire_stale` is only invoked *from the agent's own poll* (`agent-poll.ts:21`) — so with the agent silent, nothing expires and every call burns the full ~47s. When it finally times out, `AgentClient` falls through to a loopback `fetch('http://127.0.0.1:8043/...')`, which an HTTPS origin blocks as mixed content, and that failure is swallowed by a bare `catch {}` (`AgentClient.ts` print/test paths). Net effect: long spinner, then a vague or no error.
4. **It repeats forever**: the job timestamps are exactly ~47s apart — a health/status loop re-enqueues a `test` job the moment the previous one times out, which is why the queue grew to 71 dead rows.

So the architecture (browser → `edge_jobs` → agent poll → printer) is sound; the **credential lifecycle, liveness signalling and failure semantics** are broken.

## Root causes to fix

| # | Defect | Location |
|---|--------|----------|
| R1 | `startRelay()` loads `workstation.json` **once at process start** and never reloads; a rotated secret silently 401s forever, hidden behind a generic 15s backoff warning | `agent/src/relay.ts` (`loadConfig` called once, `POLL_ERROR_BACKOFF_MS`) |
| R2 | Rotation writes the new secret then calls `agent.start()`, but nothing verifies the agent re-authenticated afterwards; a failed restart looks like success | `packages/desktop/src/pages/Auth.tsx`, `packages/desktop/electron/main.cjs` |
| R3 | Auth/poll failures are invisible: no `auth_failed` state surfaced to the desktop UI or the cloud | `agent/src/relay.ts`, `agent/src/manifest.ts` |
| R4 | The ERP treats cached manifest rows as proof of liveness; "authorized" and "online" never require a live round trip | `DeviceRegistryCard.tsx`, `useHardwareRegistryCrud`, `EdgeRelayMount.tsx` |
| R5 | No liveness gate before enqueueing: jobs are queued to a demonstrably dead workstation and wait the full deadline | `RelayTransport.dispatch` |
| R6 | Stale-job expiry depends on the agent that is offline; queue never self-cleans | `agent-poll.ts:21`, missing scheduled expiry |
| R7 | Interactive deadline is 45s and identical for a health probe and a print; loopback fallback has no `AbortSignal`; failures swallowed | `RelayTransport.ts`, `AgentClient.ts` |
| R8 | Health loop re-enqueues on a fixed ~47s cadence with no backoff or dedupe against an offline workstation | health/status polling path in the hardware hooks |

## Plan

### Phase 1 — Make the workstation credential self-healing (fixes the actual outage)
1. `agent/src/relay.ts`: re-read `workstation.json` when its `mtime` changes, and unconditionally re-read on any `401`/`404` poll response. Distinguish transport errors (backoff) from auth errors (reload config, then short retry).
2. Emit an explicit `relay.auth_failed` state (with reason) into the agent logger and expose it on `GET /status` and to the desktop supervisor, so "my credential is stale" is a first-class, visible condition instead of a silent warning loop.
3. Same treatment for the manifest publisher: a 401 must raise the same visible state rather than silently stopping device updates.
4. Desktop `Auth.tsx` rotation becomes verify-after-rotate: write config → restart runtime → poll `/status` until the relay reports a **successful cloud poll**, and show a hard error if it does not happen within a few seconds. Add the same verification to the Overview/Diagnostics tabs.

### Phase 2 — Honest liveness, everywhere
5. Add a workstation liveness notion (heartbeat freshness from `last_seen_at`, plus a `relay_state` reported by the agent). Expose it through the existing `edge/workstation/*` surface.
6. `RelayTransport.dispatch()` performs a liveness pre-check: if the workstation has not polled within the heartbeat window, fail immediately with a specific, actionable error ("Workstation last checked in 30 minutes ago — the AccrualFlow Edge runtime is not connected") instead of enqueueing a job that will rot.
7. The IoT Box / Edge card's "authorize" step performs a **live echo round trip** (a cheap `status` job) before claiming "authorized (N devices)". Device rows older than the heartbeat window render as `Unknown / last seen <time>`, never `Online`.
8. Rename the card's copy from "IoT Box Agent" to the AccrualFlow Edge runtime wording already used by the desktop app, and drop the dev-only remediation hint ("start it with `AGENT_AUTH_DISABLED=1 npm --prefix agent run dev`") in favour of production guidance.

### Phase 3 — Queue hygiene and failure semantics
9. Move stale-job expiry off the agent's poll: a scheduled expiry (pg_cron on the existing `edge_jobs_expire_stale`) plus an expiry sweep on enqueue, so a dead workstation's queue self-cleans. Backfill-expire the 71 orphaned rows.
10. Per-operation deadlines instead of one 45s default: interactive test/status ≈ 8s, print ≈ 20s, discovery ≈ 30s — with the UI showing the real lifecycle (`queued → claimed → executing → done`) so a slow path is visibly slow, not indistinguishable from a hang.
11. Loopback fallback: add `AbortSignal.timeout`, and only attempt it when the page origin can actually reach loopback (skip it entirely on an HTTPS production origin instead of failing invisibly). Replace bare `catch {}` with a reported, typed error.
12. Health probes: single-flight per (workstation, endpoint), exponential backoff while the workstation is not live, and no new probe while one is outstanding — kills the 47s zombie cadence.

### Phase 4 — Verification (this is the acceptance test, not a claim)
13. Re-run your exact flow and prove it in data: a `test` job must transition `queued → in_progress → done` with `claimed_at`/`completed_at` populated, and the loopback ESC/POS emulator must receive bytes. Then the ZPL label print, checked the same way.
14. Diagnostics gains a job trail (last N jobs with claim/complete latency) and the relay auth state, so this class of failure is diagnosable by an administrator without a database query.

## Technical notes

- Nothing here weakens the security model: the workstation secret stays on the workstation, the browser continues to hold only the loopback pairing token, and the relay remains the only production path from an HTTPS origin.
- The `deadline_at` semantics stay server-authoritative; only the defaults and the expiry trigger change.
- The 71 stuck rows are expired, not deleted, so the diagnostics trail keeps the forensic history of this incident.
