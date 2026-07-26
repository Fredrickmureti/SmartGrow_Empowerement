## What the evidence shows

I traced the burst you described through the queue and both code paths.

1. **Those invoice prints never went through the cloud relay.** `edge_jobs` has only `role='test'` rows in the recent window; the last `role='print'` row is 07:47 (all `expired`). So the sales invoices took the **direct loopback path** in `AgentClient.printNetwork` → `_printNetworkDirect` (added for same-machine `127.0.0.1:9100` targets).

2. **That direct path has no timeout.** `_printNetworkDirect` calls `fetch(baseUrl + '/print')` with no `AbortController` and no deadline. On an HTTPS origin talking to `http://localhost:8043` the request can sit pending indefinitely (mixed-content / private-network block) — which is exactly "no console errors, spinner forever".

3. **One hung request blocks every later print to the same printer.** `printNetwork` runs inside `_withEndpointLock(netKey)`, a per-endpoint FIFO mutex. Invoice 1 goes out; if its fetch never settles, invoices 2–4 are parked behind it forever and never even reach the agent. This matches "the first printed, then 4 consecutive ones stopped showing".

4. **The relay path is also burst-fragile.** The agent claims **one job per poll round-trip** (`POLL_INTERVAL_MS = 1_500`), and print jobs carry a 15s deadline. Real data: job `0b14650b` was created 08:02:36 and claimed 08:02:44 — 8s of queue wait, deadline 08:02:45. A 4-invoice burst puts the last job right at the edge of expiry, and `relay.job.expired_before_run` then drops it silently.

5. **The agent's socket handling can truncate a job.** `agent/src/routes/print.ts` calls `socket.destroy()` as soon as the `write` callback fires, instead of `end()` + waiting for `close`/`drain`. With a raw-9100 receiver (and especially the ZPL/ESC-POS emulator) that can RST the connection before the payload is fully consumed. There is also no per-endpoint serialization inside the agent, so two overlapping jobs to the same one-session printer collide.

So this is not "too many invoices for the system" — it is an unbounded wait plus a strict per-printer mutex, with a queue drain rate of one job per 1.5s behind a 15s deadline.

## Plan

### 1. Bound every direct agent request (root cause of the stall)
- Add an `AbortController` + timeout to `_printNetworkDirect`, `_testConnectionDirect` and the other direct agent fetches in `AgentClient` (print ~8s, test ~6s).
- On abort, return a real failure (`agent_unreachable_timeout: …`) so the mutex releases and the next invoice proceeds.
- Result: a bad first job costs one invoice, never the whole queue.

### 2. Make the mutex non-poisoning
- Wrap each locked call in its own timeout guard so `_endpointLocks` can never hold a never-settling promise.
- Cap the wait for the lock itself (e.g. 20s); on expiry fail that job with `printer_busy: previous job to <endpoint> still in flight` instead of queueing invisibly.

### 3. Stop silently choosing a broken transport
- Tighten `_loopbackUsable()`: on an `https:` origin only allow the direct path when the agent base URL is itself `https:` (the trusted loopback TLS listener). Plaintext `http://localhost` from an HTTPS page falls back to the relay instead of hanging.
- If neither transport is viable, fail immediately with a specific message naming which one is missing.

### 4. Make the relay drain bursts instead of expiring them
- `agent-poll` returns a small **batch** of claimable jobs (up to ~5) instead of one, and the agent executes them sequentially without an extra poll round-trip between each.
- Give print jobs a queue-aware deadline: base 15s + allowance per already-queued job for the same workstation, so invoice 4 in a burst isn't judged against invoice 1's clock.
- Keep the `expired_before_run` guard, but log it to the desktop log stream with job age so it's visible rather than silent.

### 5. Harden the agent's printer write
- In `agent/src/routes/print.ts`: `socket.end(buf)` and resolve on `close` (or on `finish` + a short linger), so bytes are flushed before teardown.
- Add a per-endpoint queue inside the agent (`Map<host:port, Promise>`), mirroring the browser mutex, so overlapping jobs to one 9100 device serialize instead of colliding.
- Return `bytesWritten` only after flush confirmation.

### 6. Visible per-job feedback
- Surface each print job's lifecycle (queued → claimed → done/failed, with elapsed ms) on the hardware devices page, and toast per-invoice failures individually rather than one generic spinner.

## Technical notes
- Files touched: `src/services/hardware/local-agent/AgentClient.ts`, `src/services/hardware/local-agent/RelayTransport.ts`, `supabase/functions/edge/routes/agent-poll.ts`, `agent/src/relay.ts`, `agent/src/routes/print.ts`, plus the hardware devices UI card.
- No schema change is required for batching; it is a query/response shape change in the poll route. The queue-aware deadline is computed browser-side from a count of live `edge_jobs` rows for the workstation.
- Verification: fire 5 consecutive invoice prints and assert in `edge_jobs` that all 5 reach `done`, none `expired`, and that no job's claim wait exceeds its deadline; plus a unit test that a hung agent fetch fails one job and lets the next through.
