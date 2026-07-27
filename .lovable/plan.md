
# Enterprise Document, Printing & Hardware Architecture — Reconstruction Plan

This plan reconstructs the pipeline from **business event → printed byte** as a single, layered enterprise architecture (SAP/Oracle/Dynamics/NetSuite-shaped, not copied). Old implementations are deleted, not deprecated. Work proceeds one wave at a time; each wave lands its schema, code, guards, tests, and deletions before the next begins.

---

## 1. Target Architecture (Reference Model)

Nine layers, one owner each, no upward calls:

```text
1  Business Event Fabric        domain events (SO.confirmed, INV.issued, GRN.posted, PAY.received, ...)
2  Document Domain              typed Document aggregate (kind, version, tenant, party, legal_class, lifecycle)
3  Template Registry            per-kind templates, versioned, tenant-overridable, layout AST only
4  Rendering Engine             AST -> bytes for one of {PDF/A, ESC/POS, ZPL, EPL, HTML, CSV}
5  Artifact Store               immutable rendered bytes + manifest (document_artifacts, checksum, retention)
6  Output Intent                what the user/system wants to *do* (view, download, email, print, archive, sign)
7  Print Policy Resolver        (intent, doc_kind, org, branch, station, user) -> effective policy row
8  Hardware Platform            device registry, capabilities, health, driver ownership, transport routing
9  Delivery Queue & Audit       durable per-device queue, retries, DLQ, replay, operator feedback, audit trail
```

Rules:
- No layer above may hand-craft bytes from a layer below (no raw ESC/POS in app code — enforced today, keep).
- No layer below may know about the business event that produced the document — it sees only `Document` + `Artifact` + `Intent`.
- Every enum (doc_kind, intent, format, transport, runtime_reason) has exactly one humanization table.

### 1.1 Business events that produce documents (canonical map)

| Domain        | Event                              | Document(s)                                     | Legal? | Typical media               |
|---------------|------------------------------------|-------------------------------------------------|--------|-----------------------------|
| Sales         | quote.issued / SO.confirmed        | Estimate, Proforma, Sales Order Ack             | no     | PDF A4, email               |
| Sales         | SO.delivered                       | Delivery Note, Packing List                     | mixed  | PDF A4/A5, thermal 80mm     |
| Sales         | invoice.issued / cn.issued         | Tax Invoice, Credit Note, Debit Note            | yes    | PDF A4 (fiscal), thermal    |
| Sales         | payment.received                   | Payment Receipt                                 | yes    | PDF A4, thermal 80mm        |
| Sales         | statement.run                      | Customer Statement                              | no     | PDF A4, email               |
| POS           | pos.sale.committed                 | POS Receipt (customer + merchant), Kitchen tkt  | mixed  | thermal 58/80mm             |
| Purchases     | PO.confirmed                       | Purchase Order                                  | no     | PDF A4, email               |
| Purchases     | bill.approved                      | Vendor Bill copy                                | no     | PDF A4                      |
| Inventory/WMS | GRN.posted                         | Goods Receipt Note, Putaway list, Pallet label  | mixed  | PDF A4, thermal, ZPL label  |
| Inventory/WMS | pick.released / pack.completed     | Pick list, Packing slip, Shipping label         | mixed  | PDF, ZPL, carrier-specific  |
| Inventory     | product.identified                 | Shelf label, Price label, Item barcode          | no     | ZPL/EPL label               |
| Manufacturing | MO.released / MO.finished          | Work order, Route card, Finished-goods label    | no     | PDF, label                  |
| HR            | employee.hired / letter.issued     | Offer, Contract, Employment letter, Certificate | mixed  | PDF A4                      |
| Payroll       | payroll.finalized                  | Payslip, Bank file, Statutory return, Tax cert  | yes    | PDF A4, CSV, fiscal PDF     |
| Finance       | jv.posted / period.closed          | Journal, Trial Balance, Financial Statements    | yes    | PDF A4                      |
| Legal/Compliance | garnishment.remitted / etims.tx | Remittance advice, Fiscal receipt (ETIMS QR)    | yes    | PDF A4 + QR, fiscal path    |

Every entry above is a `Document` in the new domain. Nothing else in the codebase is allowed to invent a "document" outside this registry.

---

## 2. Current-State Findings (from investigation)

- **Two parallel rendering stacks** confirmed: POS (browser HTML + ESC/POS) and non-POS (edge-function PDF). `docs/audit/2026-05-11-printing-architecture.md` §1–3.
- **Policy surface is overloaded**: `HardwarePolicies.tsx` + `PrintPoliciesEditor.tsx` mix template concerns (paper, margins, columns) with routing (destination, silent, copies).
- **Hardware platform is already close to correct** (`mem://features/hardware-platform`, ADRs 0014, 0037, 0099, 0100): keep the chokepoint (`hardwareClient`), registry (`device_assignments`), main-process drivers, capability probe. Reuse; do not rebuild.
- **Existing good foundations to keep and formalize**: `document_artifacts` (ADR-0084), `_shared/pdf/PdfBuilder`, ESC/POS `Line[]` AST (ADR-0084), rendering ownership rules (ADR-0085), print router (ADR-0026), Enterprise Output Platform ADR-0086, media/capability (0087), label geometry (0088), barcode identity (0089), visual label designer (0090).
- **Missing pieces**: unified Document aggregate + kind registry, single Template Registry, Output Intent object, Policy Resolver as an RPC, deletion of the split POS/non-POS rendering paths.

---

## 3. Layered Design Details

### 3.1 Business Event Fabric (Layer 1)
- Reuse `src/services/events/domainEventBus` + `BusinessSaga`. All document-producing modules emit `DocumentRequested` after their own commit succeeds. No module calls the renderer directly.

### 3.2 Document Domain (Layer 2)
- `public.documents` aggregate: `id, tenant_id, org_id, branch_id, kind, version, source_module, source_event_id, party_id, legal_class, currency, locale, status, created_at`.
- `document_kinds` registry (seeded, code-owned): `code, label_i18n, legal_class, default_media_class, default_intents[], allowed_formats[]`.
- Everything downstream keys off `documents.id`, not the source business row.

### 3.3 Template Registry (Layer 3)
- `document_templates` (rewritten): `id, kind_code, scope (system|tenant|org|branch), version, ast_jsonb, theme_jsonb, header_footer_refs, is_active`.
- Layout AST is medium-neutral (blocks: header, party, table, totals, notes, barcode, qr, page-break, label). Renderers translate AST per medium.
- One editor UI (`/platform/documents/templates`) covers **all** documents (invoice, receipt, label, payslip, statement, GRN, ...). No per-module template pages.

### 3.4 Rendering Engine (Layer 4)
- `supabase/functions/_shared/render/` with pluggable renderers keyed by `format`:
  - `pdf` (existing `PdfBuilder`, extended for A3/A4/A5/Letter/Legal + custom)
  - `escpos` (existing `Line[]` compiler)
  - `zpl`, `epl` (label compilers, already in `src/services/printing/labelCompiler.ts` — moved server-side)
  - `html`, `csv` (existing)
- Input: `{ template, document, party, tokens, media }`. Output: `Artifact` bytes + `manifest`.
- App code MUST NOT call renderers directly. Sole entry: `generate-document` edge function (existing, extended).

### 3.5 Artifact Store (Layer 5)
- Keep `document_artifacts` + storage bucket (ADR-0084). Add `content_hash`, `media_class`, `format`, `retention_class`, `superseded_by`.
- Any re-print reuses the artifact; regeneration only when template or source data changes (versioned).

### 3.6 Output Intent (Layer 6)
- New value object `OutputIntent { action: view|download|email|print|archive|sign, channel?, printer_hint?, copies?, requester }`.
- All UI + server flows submit intents; nothing else. Preview/download/print buttons all become `submitIntent(document, intent)`.

### 3.7 Print Policy Resolver (Layer 7)
- Slim `printer_policies` schema: `(kind_code, org_id, branch_id, station_id, user_id, intent) -> { format, media_class, printer_role, copies, auto_print, prompt, duplex, tray, fallback_role }`.
- RPC `resolve_print_policy(document_id, intent, scope)` returns one row deterministically (most-specific-wins).
- Removes template-shaped settings (paper, margins, columns) from policies — those move to Template Registry.

### 3.8 Hardware Platform (Layer 8) — keep
- `device_assignments`, main-process drivers, transports, `hardwareClient`, capability probe, `/platform/hardware/*` operator surface (ADRs 0014/0037/0099/0100). No structural change.
- Add: `printer_role` alias table so policies name roles (`fiscal_a4`, `warehouse_label`, `kitchen`, `receipt`, `back_office`) rather than device ids.

### 3.9 Delivery Queue & Audit (Layer 9)
- Keep `hw_command_queue` + POS outbox + saga replay. Add `print_jobs` view unifying: `(document_id, intent, policy_id, assignment_id, format, bytes_ref, status, attempts, error, timeline)`.
- Operator surface `/platform/hardware/print-queue` already exists — becomes the sole job console.

---

## 4. UX Consolidation

One obvious home per responsibility:

| Concern                                | Location                                                |
|----------------------------------------|---------------------------------------------------------|
| Register/monitor hardware              | `/platform/hardware/devices`, `/diagnostics`            |
| Media & printer capabilities           | `/platform/hardware/media`                              |
| Print queue / DLQ / reprint            | `/platform/hardware/print-queue`                        |
| Print policies (routing only)          | `/platform/documents/policies`                          |
| Document templates (all kinds)         | `/platform/documents/templates`                         |
| Document customization (branding)      | `/platform/documents/branding`                          |
| Label designer                         | `/platform/documents/templates?kind=label` (unified)    |
| Per-module document actions            | in-context "Print / Email / Download" using OutputIntent|

Legacy locations (`/pos/hardware-*`, per-module template editors, `HardwarePolicies.tsx` mixed page) are deleted and redirected once for one release, then removed.

---

## 5. Delivery Waves (each wave: schema → code → guards → deletion)

**Wave 1 — Document Domain foundation.** `documents`, `document_kinds`, `document_artifacts` v2 columns; seed all kinds from §1.1; grants + RLS. No UI yet.

**Wave 2 — Template Registry rewrite.** `document_templates` v2 (AST), migration codemod from current per-module template rows into AST blocks; new `/platform/documents/templates` editor; delete per-module template pages.

**Wave 3 — Rendering Engine consolidation.** Move label compilers into `_shared/render/`; extend `generate-document` to accept `(document_id, format, media_class)`; delete `ReceiptTemplateGenerator.ts` in favor of AST→ESC/POS renderer using the same template rows.

**Wave 4 — Output Intent + Policy Resolver.** Introduce `OutputIntent`, new `printer_policies` schema, `resolve_print_policy` RPC, new `/platform/documents/policies` editor; migrate existing policy rows; delete template-shaped fields from old policy tables.

**Wave 5 — Print job pipeline unification.** `print_jobs` unified view/table; every callsite (`useDocumentPrint`, POS commit saga, label dispatch, payroll doc generation, statutory return dispatch) submits through `submitIntent`. Delete `useDocumentPrint`'s direct edge invocation path.

**Wave 6 — Hardware role aliases + resolver hookup.** `printer_roles` table, resolver returns role → `execForIntent` picks assignment (already implemented). Delete direct printer-id references in policies.

**Wave 7 — POS receipt convergence.** POS receipt template becomes a `document_kind` template. `ReceiptTemplateGenerator`, `ReceiptEscPosBuilder`, `receiptConfig.ts` PAPER_CONFIGS deleted; POS renders through the shared engine. Two paper-widths (58/80) become media classes.

**Wave 8 — Label pipeline convergence.** `labelCompiler`, `labelDispatch`, `labelBarcode` move server-side under `_shared/render/label/`; renderer app files deleted; visual designer (ADR-0090) writes AST into the same Template Registry.

**Wave 9 — Legacy purge.** Remove: `PrintService.ts` shims, deprecated `usb:*`/`serial:*` IPC channels, `pos_hardware_configs` (already dropped, verify), `HardwarePolicies.tsx` legacy page, per-module template editors, unused edge functions (`generate-payslip-pdf` etc. rewritten as thin adapters that call `generate-document`).

**Wave 10 — Guardrails & docs.** ESLint rules: `no-direct-renderer-call`, `no-direct-print-policy-read`, `no-per-module-template`; architecture tests for each; refresh ADR-0086 (Enterprise Output Platform) as the master doc; delete superseded ADRs' bodies with tombstones.

Each wave ships its own destructive migration; no wave leaves a shadow path.

---

## 6. Deletion Manifest (targets, indicative)

- `src/services/receipt/ReceiptTemplateGenerator.ts`, `ReceiptEscPosBuilder.ts` (Wave 7)
- `src/lib/receiptConfig.ts` (Wave 7)
- `src/hooks/useDocumentPrint.ts` direct path (Wave 5)
- `src/services/printing/labelCompiler.ts`, `labelDispatch.ts`, `labelBarcode.ts` (Wave 8; moved server-side)
- `src/services/printing/PrintClient.ts` legacy exports (Wave 9; replaced by `submitIntent`)
- `src/apps/platform/hardware/pages/HardwarePolicies.tsx` template-shaped fields (Wave 4)
- Per-module template editors under `src/features/**` (Wave 2)
- Superseded edge functions: consolidate `generate-payroll-document`, `generate-payslip-pdf`, `generate-tax-certificate`, `generate-audit-certificate`, `generate-annual-earnings-statement` into `generate-document` with `kind_code` dispatch (Wave 3 & 9)
- Deprecated preload IPC (`usb:print`, `usb:open-drawer`, `serial:write`) (Wave 9)

Nothing on this list survives as a fallback.

---

## 7. Engineering Standards Applied

- One owner per byte kind (ADR-0085 kept and extended to labels/CSV).
- One chokepoint per layer: `submitIntent` (app), `generate-document` (render), `resolve_print_policy` (policy), `hardwareClient` (hardware), `pos:exec` (main).
- Enum humanization stays centralized (`humanize.ts`); every new kind/format/intent added to it in the same migration.
- All new tables ship with GRANTs + RLS + validation triggers (not CHECK constraints for time).
- All new server logic is `createServerFn` (app-internal) or `/api/public/*` (webhooks); no new Supabase Edge Functions except for the render engine, which is already there.
- Tests: architecture tests per wave; e2e for each document kind (issue → render → intent → job → artifact).

---

## 8. Definition of Done

- A developer can trace any printed byte from event → document → template → renderer → artifact → intent → policy → role → device → transport in ≤ 5 files.
- No module ships its own template editor, renderer, or policy screen.
- Only one path exists to produce a PDF, one to produce ESC/POS, one to produce a label; POS and non-POS share it.
- `/platform/documents/*` and `/platform/hardware/*` are the only surfaces users see for these concerns.
- All legacy files listed in §6 are removed from `main`.

---

## Next Step

On approval, begin **Wave 1** (Document Domain foundation): migration for `documents`, `document_kinds`, artifacts v2 columns, kind seed data, grants + RLS, plus the humanize entries. No UI or renderer changes in Wave 1 — foundation only, so every following wave has a stable spine to attach to.
