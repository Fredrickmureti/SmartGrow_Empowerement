# ADR-0026 — Cross-app print router

- **Status:** Accepted (2026-06-17). Implementation deferred to wave B1.
- **Predecessor:** ADR-0008 (print policies), ADR-0014 (hardware chokepoint), ADR-0037 (hardware execution topology).
- **Companion audit:** `docs/audit/2026-06-17-hardware-enterprise-readiness.md`.

## Context

`PrintClient.print({documentType, documentId, intent})` exists at `src/services/printing/PrintClient.ts:68`. It already resolves bytes via `generate-document`, picks the right transport per intent (`receipt | kitchen_ticket | label | a4_document | packing_slip`), and dispatches through `hardwareClient`. Every print routed through it is automatically recorded in `hardware_exec_log` with `source_doc_type`, `source_doc_id`, and `business_event_id`.

Despite this, 12 surfaces still print via the older `useDocumentPrint → PrintPreviewDialog` path (rg-verified 2026-06-17):

`Invoices, SalesOrders, Estimates, DeliveryNotes, CreditNotes, ProformaInvoices, CustomerPayments, Bills, PurchaseOrders, PurchaseReturns, SalesReturns, CreditNoteDetailDialog`.

The shadow path:
- Has no policy resolution — the operator picks the destination on every print.
- Logs to `hardware_exec_log` **only** when the operator manually chooses a thermal destination; A4 prints are invisible to the platform.
- Has no thermal/A4 fallback awareness.
- Cannot be governed by `document_print_policies.auto_print`.
- Is incompatible with retail compliance regimes that require a hardware-audit trail (Kenya eTIMS reprint tracking, EU fiscal-receipt rules, internal duplicate-detect controls).

## Decision

1. **`PrintClient.print({documentType, documentId, intent})` is the only sanctioned entry point for any document print across Sales, Purchases, Finance, Inventory, POS, and HR.**
2. `PrintPreviewDialog` is demoted to a **fallback** for the case where the resolved policy returns `ask_user: true` (no auto-routing configured). It is no longer the default UI.
3. A new `print_policies.resolve` RPC returns `{device_id, paper_format, copies, ask_user}` for a `(business_id, branch_id, document_type, intent)` tuple. `PrintClient.print()` calls it first; if `ask_user` is `true`, it opens `PrintPreviewDialog`; otherwise it sends bytes straight to `hardwareClient`.
4. **Two ESLint guards land with the migration:**
   - `no-direct-window-print` — forbids `window.print()` anywhere outside `pdfUtils.ts`.
   - `no-document-print-shadow-path` — forbids `import … from '@/hooks/useDocumentPrint'` outside `src/components/print/PrintPreviewDialog.tsx`.
5. **Golden test** `src/test/printing/cross-app-print-routing.test.ts` static-analyses the 12 page files and asserts each one imports `printClient` (not `useDocumentPrint`).
6. Role-enum canonicalisation (`scanner` → `barcode_scanner`) and `a4_printer` role wiring travel in the same wave because A4 routing needs the enum (`a4_printer` was already added to `HARDWARE_ROLES` in Wave 12 closeout).

## Consequences

- Every page print becomes auditable through `hardware_exec_log` regardless of transport (thermal or A4 PDF spool).
- Operators stop seeing the preview dialog on every print at sites where IT has configured policies — measurable productivity win at supermarket scale.
- One fewer parallel print pipeline to maintain.
- The `useDocumentPrint` hook is retained (not deleted) so `PrintPreviewDialog` can still drive the manual fallback when policy explicitly defers to the operator.

## Migration plan (wave B1)

| Step | Surfaces | Done when |
|---|---|---|
| 1 | Land `print_policies.resolve` RPC + unit tests | RPC returns expected shape for all 13 document types |
| 2 | Extend `PrintClient.print()` to call the RPC, branch on `ask_user`, and import `PrintPreviewDialog` lazily | Existing POS callers regress-free |
| 3 | Migrate first surface (Invoices) | Golden test passes for Invoices; manual smoke OK |
| 4 | Migrate remaining 11 surfaces | Golden test passes for all 12 |
| 5 | Land both ESLint guards as `error` | CI green |
| 6 | Update `HARDWARE_CAPABILITY_MATRIX.md`, `mem/features/hardware-platform.md` | Docs match code |

Each migrated page in step 3-4 is a verifiable slice (one file + one test). The wave is sized to land in 1-2 days of focused work, not in a single audit-mode turn.

## Alternatives considered

- **Delete `PrintPreviewDialog` outright.** Rejected: the operator-pick fallback is genuinely useful when no policy is configured (greenfield tenants, dev/staging).
- **Server-side resolve everywhere (no `ask_user`).** Rejected: forces every tenant to configure policies on day 1, hostile to onboarding.
- **Leave the shadow path in place and only audit it.** Rejected: violates the single-chokepoint invariant established by ADR-0014.

## Related

- ADR-0008 — Document print policies (`document_print_policies` table)
- ADR-0014 — Hardware chokepoint
- ADR-0037 — Hardware execution topology
- `docs/audit/2026-06-10-hardware-print-reaudit.md`
- `docs/audit/2026-06-17-hardware-enterprise-readiness.md`