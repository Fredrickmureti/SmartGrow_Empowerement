## What I confirmed

- The workstation is not simply “disconnected”: recent Edge Function analytics show repeated `POST /functions/v1/edge/agent/poll` returning **500**.
- That means the desktop agent can show “authorized” from manifest/status traffic, but its job-poll loop is failing, so queued print/test jobs are not being claimed before the browser deadline.
- There are currently stuck `queued` jobs whose deadlines have already passed, so they must be expired before they can ever print late.
- The “Loopback test print” is still routed through the cloud relay when relay is enabled. For a same-machine printer at `127.0.0.1:9100`, that is the slow/wrong path compared with Odoo-style local IoT handling.

## Plan

1. **Repair the relay poll backend**
   - Replace `public.edge_jobs_expire_stale()` with a safe PL/pgSQL version that does not cause the poll route to fail.
   - Explicitly grant execute on that function.
   - Expire all already-dead queued/in-progress jobs immediately so they cannot print late.

2. **Make `agent-poll` ignore stale jobs even if cleanup fails**
   - Update `supabase/functions/edge/routes/agent-poll.ts` so it only selects jobs where `deadline_at > now()`.
   - Log/return clearer errors around cleanup/claim failures instead of letting the whole poll path silently become a generic 500.

3. **Stop calling a relay timeout “printer unreachable” when the poll endpoint is failing**
   - Update `RelayTransport` timeout text to distinguish:
     - agent not polling,
     - job not claimed,
     - job claimed but no completion,
     - printer route error.
   - Keep the anti-ghost-print expiry behavior.

4. **Make true local loopback tests fast**
   - For `127.0.0.1` / `localhost` hardware tests from the desktop/local environment, prefer the direct local agent route instead of forcing Supabase relay.
   - Keep relay for production HTTPS browser paths where direct loopback is blocked.

5. **Verify the result**
   - Confirm the poll endpoint stops returning 500.
   - Confirm stale queued jobs are expired.
   - Confirm new jobs are claimed quickly or fail with the real printer/socket error rather than spinning to `relay_timeout`.

## Expected behavior after this

- If the desktop agent is authorized and polling: a job should be claimed in about 1–2 seconds.
- If `127.0.0.1:9100` is reachable from the machine running the desktop app: the test print should complete immediately.
- If the printer/simulator is not reachable: the UI should show the actual socket error quickly.
- No old queued job should print 5–10 minutes later.