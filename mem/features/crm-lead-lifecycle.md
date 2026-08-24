---
name: CRM lead lifecycle is server-owned
description: crm_leads lifecycle state (status/stage/won/lost/probability/assignment/value) may only change through the crm_* transition RPCs, never a client update
type: feature
---

`crm_leads` is one entity with two faces (`type` = lead | opportunity). Its
lifecycle is a database state machine, not client fields.

- `crm_leads.status` (`crm_lead_status`: new, qualified, proposition, won,
  lost, archived) is the single source of truth. `stage_id` is presentation
  ordering within the open states.
- Transitions are the only writers: `crm_qualify_lead`, `crm_change_stage`,
  `crm_mark_won`, `crm_mark_lost`, `crm_reopen_lead` (reason mandatory),
  `crm_reassign_lead`, `crm_revalue_lead`, `crm_archive_lead`. All are
  SECURITY DEFINER and gated on `public._crm_assert_lead_access`; none are
  executable by `anon`.
- `_crm_lead_lifecycle_write_guard` rejects any direct UPDATE of
  status/stage_id/won_at/lost_at/probability/type/assigned_to/lost_reason_id/
  expected_revenue/is_active. Descriptive fields stay client-editable.
- Invariants: won and lost are mutually exclusive (`crm_leads_terminal_consistency`),
  stage/contact/assignee must belong to the lead's business, one won stage and
  one lost stage per business, and a stage holding open opportunities cannot be
  deactivated.
- The pipeline board therefore cannot drag into a terminal stage: Won routes to
  `crm_mark_won`, Lost demands the Mark-as-Lost dialog so a reason is captured.

Guards: `src/test/architecture/crm-lifecycle-rpc-only.test.ts`,
`supabase/tests/crm_lifecycle_state_machine_test.sql`,
`supabase/tests/crm_domain_contract_test.sql`.
