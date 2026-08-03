# Cycle Count — verification verdict and remaining roadmap

Authoritative status file. Update it in the same turn as any code change.

## Phase 1 — independent verification of the previous engineer's claims

Every claim was re-checked against the live database catalogue and the source
tree, not against the previous notes.

| Claim | Verdict | Evidence found |
|---|---|---|
| Phase A — legacy `record_count` / `create_count_session` overloads deleted | ✅ Confirmed | `pg_proc` holds exactly one `record_count(line, qty, note, reason, serials, expiry)` and one `create_count_session(warehouse, strategy, locations, notes, is_blind, assign_to)`; no bypass signature survives |
| Phase A — recount loop | ✅ Confirmed | `request_count_recount(line, reason)` exists in the database; `useRequestRecount.ts` present; supervisor action wired in `CountReview.tsx` / `CountSession.tsx` |
| Phase B — lot / serial / expiry capture | ✅ Confirmed | `useProductTracking.ts` exists; `src/pages/warehouse-mobile/MobileCount.tsx` passes `p_serial_numbers` and `p_expiry_date` into the single `record_count` |
| Phase C — supervisor command centre | ✅ Confirmed | `get_count_session_board` and `get_count_command_center` both exist server-side; `CycleCounts.tsx` (442 lines) consumes them through `useCountCommandCenter.ts` and virtualises the grid with TanStack Virtual |
| Blind-count masking, single ledger path, RLS | ✅ Confirmed structurally | `get_count_lines` is the sole read path and is guarded by `cycle-count-integrity.test.ts`; posting still flows through the inventory document, never straight to stock |
| Phase D — printable count documents | ❌ Not started | No `count_sheet`, `count_sheet_blind`, `count_variance_report`, or `count_audit_report` anywhere in `src`, `supabase`, or `docs`; nothing registered in `FETCHER_MAP` |
| Phase E — database test hardening | ❌ Not started | No cycle-count test file under `supabase/tests/`; ADR 0106 has no verification addendum |

Conclusion: work stopped exactly where the notes said, and the completed
phases hold up. Resume at Phase D. No rework of A–C is required, but two
gaps found during this audit are added below as Phase F.

## Phase D — count documents (next)

Register four artifacts through the sanctioned printing pipeline, following
`docs/printing-add-new-artifact.md` (ADR 0084/0085/0086/0088). One artifact at
a time, each fully wired before the next begins.

1. `count_sheet` — bins, products, expected quantity, blank count column.
2. `count_sheet_blind` — a separate fetcher with no expected quantity, so a
   blind count can never leak through a misconfigured flag.
3. `count_variance_report` — posted variances with reason codes and approver.
4. `count_audit_report` — full attempt history including every recount round.

Per artifact: `fetchXxx()` plus a `FETCHER_MAP` row in
`supabase/functions/generate-document/index.ts`; dispatch only through
`printDocument` / `usePrintOrPreview`; a `WIRED` row added to
`docs/printing-event-coverage.md` in the same change; a wiring test modelled on
`src/test/printing/drawer-slip-wiring.test.ts`. Finish with the four
verification commands at the end of the printing runbook.

## Phase E — database hardening

New pgTAP suite `supabase/tests/cycle_count_invariants_test.sql` asserting:
tolerance branching, blind-mode masking, recount linkage to the parent line,
the single posting path, the reason-code gate on out-of-tolerance lines,
approver is never the counter, and the permanent absence of the deleted
overloads. Add a verification addendum to ADR 0106.

## Phase F — gaps found in this audit (new)

1. **Approver-is-not-counter is unenforced in the database.** It is currently
   an expectation, not a constraint. Add the check inside the approval path so
   the rule cannot be bypassed by any client.
2. **Reason-code gate lives partly in the client.** Confirm the mandatory
   variance-reason rule is rejected server-side on submit, not just disabled in
   the UI, and move it if it is not.

Both are small, high-value integrity fixes; do them alongside Phase E so the
pgTAP suite proves them.

## Guardrails

- No fourth renderer, no hand-rolled `pdf-lib` in `src/**`, no new print
  transport.
- All stock movement continues to flow only through Inventory's
  approval → adjustment → journal-entry path. Warehouse never writes stock.
- Hardware needs no work: wedge, camera and Bluetooth scanners all resolve
  through the same `BarcodeInputField` → `resolve_*_identity` seam, and RF
  terminals already run the mobile shell.
