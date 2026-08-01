
# Enterprise Printing & Document Output — Consolidation Plan

## What I found (independent audit)

The subsystem is closer to enterprise-grade than the surrounding documentation suggests, but it carries a second live execution path and a stale documentation layer that actively misdescribes the architecture.

**The real pipeline today** (verified in code):

```text
Business event / operator action
  -> features/*/dispatch*.ts  (snapshot builder)
  -> ensureDocumentRecord()   (immutable document_records, ADR-0084)
  -> PrintService.printDocumentIntent()
       1 policy.resolvePrintPolicy   medium / paper / copies
       2 jobs.openJob                durable print_jobs ledger row
       3 render.*                    bytes
       4 dispatch.toDevice/toPage/toDownload
  -> hardwareClient.exec -> device_assignments -> Electron driver | LAN agent :8043 | browser
  -> submit-document-intent -> dispatch-print-jobs (pg_cron drainer) -> disposition fan-out
```

**Confirmed strengths.** One client chokepoint (`PrintService`), one hardware chokepoint (`hardwareClient`), a durable `print_jobs` ledger, immutable document records/artifacts, server-only PDF and barcode ownership, a pg_cron spool drainer with SKIP LOCKED and an SLO monitor, and ~20 guard tests plus 29 ESLint architecture rules. The Label/POS dispatch path is genuinely the strongest implementation and is the right reference model.

**Confirmed problems.**

1. **Two rendering backends run in parallel.** `render.ts` exposes `renderDocumentRecord` (canonical, `render-document`) and `renderSourceDocument` (legacy, `generate-document`). `PrintService` calls the legacy one from three call sites and the canonical one from one. So ADR-0084's byte-identical-reprint guarantee does not actually hold platform-wide.
2. **A second rendering surface bypasses `PrintService` entirely.** `PrintPreviewDialog` and `PrintSettingsPopover` invoke `generate-document` directly, so previews produce different bytes than prints, with no ledger row and no audit.
3. **Self-service documents have no pipeline at all.** `MyPayslips`, `MyTaxCertificates`, `MyDocuments` use bespoke download handlers and separate edge functions — no print job, no reprint, no history — even though `PrintService` advertises payslip support.
4. **Two print-queue operator screens** read the same `print_jobs` table: `/admin/PrintQueuePage.tsx` and `/platform/hardware/print-queue`.
5. **The documentation layer describes an architecture that no longer exists.** `docs/printing-pipeline.md`, `docs/printing-add-new-artifact.md` and ADR-0026 all name `PrintClient.ts` as canonical; that file was deleted. Two guard tests they cite do not exist. `eslint-rules/no-printservice-shim.js` still points at the dead module. `mem/features/hardware-platform.md` describes `device_assignments` columns that are not in the schema.
6. **Carried-forward hardware findings** from the June re-audit that need re-verification: inline ZPL in `Products.tsx`, orphan `a4_printer` role, `LineDisplayDriver` pointing at a dead bridge, `BluetoothTransport.send` hardcoded to fail, non-constant-time token compare and wildcard CORS in the LAN agent.

## Architectural direction

One pipeline. Document type becomes **configuration** (kind code, snapshot builder, template, output policy) and never a separate execution path. Preview, print, email, download and archive become **dispositions of one job**, not separate code. The spool is infrastructure behind `PrintService`, never a second front door.

## Work plan

### Phase 0 — Verification pass (no code changes yet)
Re-confirm the carried-forward findings against current source (Products.tsx ZPL, a4_printer, LineDisplayDriver, BluetoothTransport, agent auth/CORS), run the existing guard suite and lint to establish a true baseline, and check `docs/printing-event-coverage.md` for non-WIRED rows. Record results in a findings document.

### Phase 1 — Single rendering backend
Migrate every remaining document type onto `document_records` + `render-document`. Any type still needing `generate-document` gets a snapshot builder in this phase. Then delete `renderSourceDocument`, remove the legacy branches in `PrintService`, and retire the `generate-document` edge function. Outcome: one renderer, and reprints are byte-identical everywhere.

### Phase 2 — Preview becomes a disposition
Rebuild `PrintPreviewDialog` on top of a `PrintService` preview disposition that renders through the same path and records the same ledger row. Paper-format overrides move into policy parameters rather than a direct edge call. Delete the direct `generate-document` calls from `PrintPreviewDialog` and `PrintSettingsPopover`.

### Phase 3 — Close the coverage gaps
Bring payslips, tax certificates and the HR document store onto the pipeline: snapshot builders, kind codes, output policies, and the standard print/preview/reprint affordances. Delete the bespoke download edge functions they currently use. Audit remaining kind codes for surfaces that exist in the registry but have no UI.

### Phase 4 — Legacy deletion sweep
Delete `PrintClient` remnants and stale comments, rewrite `docs/printing-pipeline.md` and `docs/printing-add-new-artifact.md` against the real architecture, supersede ADR-0026 with a new ADR recording the `PrintService` design, fix `no-printservice-shim.js` to target the real module, and correct `mem/features/hardware-platform.md` to match the actual `device_assignments` schema. No fallbacks, no adapters, no deprecated modules retained.

### Phase 5 — Hardware layer cleanup
Fix or remove the dead driver paths found in Phase 0 (LineDisplayDriver, BluetoothTransport, orphan roles), and harden the LAN agent (constant-time token compare, scoped CORS). A permanently-failing transport must either work or not be registered.

### Phase 6 — Unified operator workspace (UX)
Merge the two print-queue screens into one operator surface under the hardware workspace, with the other redirecting like the already-retired `roles`/`capability` routes. The queue answers one question in business language: *did it print, and if not, why*. Terminology audit across all printing UI — no "output intent", "document record", "kind code", "device assignment" in rendered copy; they become "print rule", "document", "document type", "printer". Standardise the print button: same label, same pre-flight guard, same toast, same reprint and history affordance on every printable record. `ReprintButton` and `DocumentHistoryPanel` get wired onto every document surface, not just labels and receipts.

### Phase 7 — Guardrails
Extend `printing-architecture.test.ts` so the single-renderer and single-front-door invariants are enforced, add coverage-matrix rows for the newly wired document types, and add lint rules banning any direct edge-function document call outside `src/services/printing/`. Every invariant this work establishes must fail CI if violated.

## Technical notes

- Phases 1 and 2 are the load-bearing ones; 3 through 7 are mechanical once one renderer exists.
- Destructive migration is used throughout: legacy modules are deleted in the same phase their replacement lands, not deprecated.
- No database rewrite is planned. `document_records`, `document_artifacts`, `print_jobs`, `device_assignments` and the output-policy tables are sound; the work is adoption, not redesign.
- Each phase ends with the guard suite green, so the subsystem is never left with two live paths across a phase boundary.

## Phase 3 — HR/Payroll onto the canonical pipeline (ACTIVE, ~90% complete)

Implemented and typechecking clean (`tsgo --noEmit`: 0 errors):
- `supabase/functions/_shared/payslip/payslipSnapshot.ts` — frozen payslip projection + pure renderer (single source of payslip layout).
- `supabase/functions/_shared/payslip/payslipAccess.ts` — one authorization gate (self-service employee OR `payroll.read`).
- `supabase/functions/generate-payslip-pdf/index.ts` — reduced to a thin server-to-server shim (email only); owns no projection/layout.
- `supabase/functions/ensure-payslip-document/index.ts` — NEW. Builds the snapshot, authorizes, upserts `document_records` (`payroll.payslip`), returns the record id. Never renders, never prints.
- `_shared/rendering/renderers/pdf.ts` — `payroll.payslip` routed to the statement layout so `render-document` and the email shim emit identical bytes.
- `src/services/printing/PrintService.ts` — added `downloadDocumentRecord` (download is a ledgered disposition: job row → render-document → download → settle).
- `src/services/payroll/payslipDocuments.ts` — NEW client seam (`ensurePayslipDocumentRecord`, `downloadPayslipPdf`, `printPayslip`).
- All four payslip surfaces migrated off `functions.invoke('generate-payslip-pdf')`: `pages/me/MyPayslips.tsx`, `components/employees/EmployeePayslipHistory.tsx`, `components/payroll/PayrollRunDetailsDialog.tsx`, `pages/hr/payroll/sections.tsx`.

Pending (do these FIRST, before any new phase):
1. Three payslip guard tests were repointed from `generate-payslip-pdf/index.ts` to `_shared/payslip/payslipSnapshot.ts` and now FAIL:
   `payroll-engine-contract` (synthetic Basic Salary row), `payslip-header-surface-contract` (statutory IDs must come from the shared payslip header, not direct table reads), `payslip-header-country-agnostic`.
   The extracted module must be corrected to satisfy them — do NOT relax the guards.
2. Add an architecture guard forbidding `generate-payslip-pdf` anywhere in `src/` (server-to-server only).
3. Tax certificates (`pages/me/MyTaxCertificates.tsx`) still bypass the pipeline — same treatment (`ensure-*-document` + `downloadDocumentRecord`).
4. Deploy the new `ensure-payslip-document` function and smoke-test download + reprint byte-identity.

Note: the wider suite has ~145 pre-existing failures unrelated to printing (payroll country-agnostic guards, tax-certificate RPC, etc.). Baseline them before attributing failures to this phase.

### Instructions for the next agent
Verify the Phase 3 work above against enterprise standards (one projection, one gate, ledgered downloads, byte-identical reprints) and close out items 1–4 in order. Only then move to Phase 4 (legacy deletion sweep). Do not start unrelated work.
