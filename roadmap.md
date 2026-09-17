# Roadmap

Authoritative detail lives in `.lovable/plan.md`.

- [x] ERP strip — code side closed; DB down to `contacts`, `payments`, `payment_allocations`.
- [x] Microfinance domain end-to-end (clients → … → closure).
- [x] Report catalogue, money-in/out, finance config retargeted; FX purged.
- [x] Field/group meeting lifecycle — meeting event, workspace, day list, meeting-stamped collections, tests.
- [x] Meeting wave follow-up — in-meeting "Register a client here" stamps `mf_clients.onboarded_meeting_id`.
- [ ] M1 — Owner verification pass in the signed-in preview.
- [x] Branch Operational Day — day table/event log, open/close/reopen RPCs, ledger + batch day locks, per-branch activation, UI surface; all invariants re-verified live.
- [x] Fiscal period close/reopen now sets `is_closed` and `is_period_open` reads both markers.
- [x] Branch Operational Day — stale-open-day alert (day screen + money date field) and daily branch cash report.
- [ ] Branch Operational Day — signed-in walkthrough (blocked: needs a preview sign-in on your own Supabase).
- [ ] M5a — Drop `payments`/`payment_allocations`; sweep ERP dashboard widget ids.
- [ ] M5b — Drop `contacts` (journal counterparty → `mf_clients`).
- [ ] M7 — Orphan function purge.
- [ ] M8 — Linter posture on retained schema.
- [ ] M9 — Microfinance report gaps.
- [ ] Resource Center: remove the inert demo-video section (`useDemoVideos` is now a stub; `platform_demo_videos` is dropped).
- [ ] M10 — Microfinance document gaps (borrower repayment schedule export/print done: richer borrower summary, assessed-penalty column, Print verb, schedule-screen actions, internal XLSX extract, snapshot tests; other M10 documents still open).
- [x] Invitation branding and links use Smart Grow Empowerment at `https://www.growastepventures.co.ke/` only.
