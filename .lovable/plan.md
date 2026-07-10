## Verified findings

**Immediate production defect**
- `SCR-2026-00001` exists as a real scrap document in `stock_adjustments` with `adjustment_type='scrap'`, status `approved`, value `210`, JE `JE-00003`, stock movement, and `scrap.posted` outbox event.
- The scrap page hides it because `ScrapRecording.tsx` filters rows with `(r as any).adjustment_type === 'scrap'`, but the query does not select `adjustment_type`. Every row is therefore filtered out client-side.

**What the previous implementation actually delivered**
- Scrap is partially promoted from a bare movement to `stock_adjustments` + `stock_adjustment_items` via `record_scrap_atomic`.
- It delegates posting to `approve_stock_adjustment_atomic`, so stock movement, valuation, cost resolution, lot consumption path, and GL posting reuse the hardened adjustment engine.
- `scrap_reasons`, `scrap_attachments`, `scrap.posted`, `scrap.reversed`, and scrap SoD catalogue entries exist.
- The UI has a log, reason setup page, and detail sheet, but it is still single-line and has direct RPC calls in `ScrapNew.tsx` despite `useScrap` saying it is canonical.

**Architectural gaps still present**
- No dedicated `create_scrap_atomic`, `approve_scrap_atomic`, `post_scrap_atomic`, or `reverse_scrap_atomic`; only a wrapper over stock adjustment approval exists.
- Scrap lifecycle status is inconsistent: database status remains `approved` even though GL is posted; the outbox calls it `scrap.posted`.
- Reason thresholds and required attachments are stored but not enforced before posting.
- Reason-specific GL mapping is shallow: reasons mostly collapse to shrinkage instead of resolving configurable `offset_account_purpose` through the canonical default-account architecture.
- The reason setup UI hardcodes `offset_account_purpose: "shrinkage"` and does not let finance configure the purpose.
- No attachment upload/verification workflow exists.
- Governance is limited to self-approval guard; approval thresholds/maker-checker are not yet wired into the approval framework.
- Reporting is UI-local and fragile; no canonical scrap reporting view/query exists for KPIs, lists, and drill-down.

## Implementation plan

### 1. Fix the current user-visible reporting defect first
- Add `adjustment_type` to the `ScrapRecording.tsx` query, or better, filter `adjustment_type='scrap'` in the database query now that the column exists in generated types.
- Keep `approved` treated as posted only where the current engine genuinely posts the JE during approval.
- Change the empty state copy only if no scrap documents truly exist.
- Validate that `SCR-2026-00001` appears in the list and KPI cards show:
  - Posted this month: `1`
  - Loss MTD: `210`
  - Loss today: `210`

### 2. Remove shallow frontend inconsistencies
- Make `ScrapNew.tsx` use `useRecordScrap` instead of calling `record_scrap_atomic` directly.
- Update `ScrapRecording.tsx` reason filters to use database `scrap_reasons`, not the legacy hardcoded catalogue.
- Ensure the detail sheet shows the linked JE, stock movement, unit cost, total value, requester/approver, and outbox/audit status where available.
- Add an architecture test that prevents client-side filtering by a column that is not selected.

### 3. Make reporting canonical
- Add a database view or RPC for scrap dashboard/list rows that returns document header, line totals, status, reason, warehouse, JE id/number, movement count, requester, approver, and financial value.
- Point the scrap page and detail sheet at this canonical read model so KPI cards and lists cannot drift from the posting model.
- Include legacy orphan visibility for any historical `stock_movements` scrap rows that do not have a `stock_adjustments` header, clearly marked as legacy.

### 4. Enforce enterprise controls that currently only exist as fields
- Enforce `scrap_reasons.requires_attachment` before posting.
- Enforce `requires_approval_above` by routing above-threshold scrap through existing approval/governance tables instead of immediately approving.
- Keep solo-organization behavior safe, but do not allow multi-user orgs to self-approve material scrap without a governance override.
- Add tests for threshold, attachment, and self-approval behavior.

### 5. Complete accounting configuration properly
- Replace reason hardcoding in `resolve_adjustment_offset_account` with lookup of `scrap_reasons.offset_account_purpose`.
- Resolve the offset account through the existing default-account/account-role architecture rather than adding another mapping system.
- Expose offset-account purpose in the reason setup UI.
- Fail fast when an account cannot be resolved; never post stock without GL.

### 6. Close lifecycle gaps
- Introduce dedicated scrap RPCs only where they add lifecycle semantics beyond the generic stock-adjustment engine:
  - create/request scrap
  - approve/post scrap
  - reverse scrap
- Preserve `record_scrap_atomic` as a backwards-compatible wrapper.
- Align statuses so posted scrap is unambiguous in UI, reports, and outbox events.
- Add regression tests for stock movement, cost resolution, JE linkage, outbox emission, reversal, and dashboard visibility.

### 7. Validate end-to-end
- Reproduce the current failure on the scrap page.
- Apply the fix and verify the same posted scrap appears in the dashboard/list.
- Verify database state for document, item, stock movement, JE, and outbox.
- Run focused architecture/unit tests for scrap lifecycle and stock adjustment posting.