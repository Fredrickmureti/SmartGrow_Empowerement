# ADR-0084 — Immutable Document Artifacts

**Status:** Accepted (Wave B3 kickoff)
**Depends on:** ADR-0026 (cross-app print router), ADR-0074 (hardware audit)
**Owners:** Document Platform

## Context

The `generate-document` edge function renders every PDF, ESC/POS receipt,
and ZPL label the app produces. Today the rendered bytes are streamed
straight back to the browser and thrown away — there is no immutable
record of what was printed.

That breaks several enterprise requirements:

1. **Byte-identical reprints.** If a template is edited after an invoice
   is emailed to a customer, the "Reprint" button today re-renders with
   the *new* template. The customer receives a document that no longer
   matches what they filed for VAT / tax audit.
2. **Regeneration history.** Compliance officers need to see how many
   times a document was regenerated, by whom, and why (template updated,
   policy changed, user-requested duplicate).
3. **eTIMS / fiscal audit.** KRA-style fiscal regimes require the
   original signed artifact to be retrievable for years, not just the
   source row.
4. **Debugging.** When a customer complains a PDF was wrong, support has
   no way to fetch the exact bytes that were sent.

The `document_print_policies` and hardware-audit tables already exist,
but they record *intent* to print, not the *result*.

## Decision

Introduce a `document_artifacts` table backed by a private
`document-artifacts` Supabase Storage bucket. Every render — original,
reprint, or duplicate — inserts a new row and uploads a new object;
existing rows are **never mutated**.

### Schema

```
document_artifacts (
  id, organization_id, business_id, branch_id,
  document_type, document_id, document_number, intent,
  version,                     -- auto-incremented per (biz, type, doc)
  template_id, template_version,
  policy_id,
  storage_bucket, storage_path,
  mime_type, byte_size, content_sha256, page_count,
  render_mode, paper_format, copies,
  rendered_by, rendered_via, regeneration_reason,
  supersedes_id,               -- self-FK to previous version
  metadata jsonb,
  created_at
)
```

### Access

- **Read:** business members via RLS on both the table and
  `storage.objects` (prefix match on `<business_id>/…`).
- **Write:** `service_role` only. `generate-document` is the sole writer.
  No `INSERT/UPDATE/DELETE` grants exist for `authenticated`.
- **Never mutable:** no `UPDATE` policy. Regeneration = new row with
  incremented `version` and `supersedes_id` pointing at the prior one.

### Storage path convention

```
<business_id>/<document_type>/<document_id>/<artifact_id>.<ext>
```

`business_id` is the first segment so the RLS policy on
`storage.objects` is a cheap `split_part(name, '/', 1)` check.

### Client API

`src/services/documents/DocumentArtifactStore.ts` exposes:

- `latest({ businessId, documentType, documentId })` — for reprints
- `list(...)` — for the history panel
- `signedUrl(artifact)` — 5-minute signed URL for preview/download

The store is **read-only**. New renders continue to go through
`printClient.print()` → `generate-document` edge function.

### Edge-function contract (Wave B3.2, next PR)

`generate-document` gains a post-render step:

1. Compute `sha256(bytes)`.
2. If `documentType` is on the "persist" allow-list (invoice, bill,
   credit_note, receipt, delivery_note, purchase_order, statement,
   payslip) and the render is not `intent=preview`, upload the bytes
   and insert a `document_artifacts` row.
3. If a previous artifact for the same document exists with a matching
   `content_sha256`, skip the upload — no changes since last render.
4. Return the artifact id alongside the bytes so clients can pin the
   version they just previewed.

## Consequences

**Positive**
- Reprints become O(1) storage reads; no template re-render.
- Full audit trail with `supersedes_id` + `regeneration_reason`.
- Support can debug "wrong PDF" tickets against the exact bytes.
- Sets up eTIMS / KRA long-term retention out of the box.

**Negative**
- Storage cost grows with document count. Mitigation: content-hash
  dedupe skips uploads when nothing changed, and a Wave B3.3 GC job
  will retire artifacts older than the fiscal retention window
  (jurisdiction-configurable via `localization_pack_certificate_templates`).
- `generate-document` gains a storage write on the hot path. Mitigation:
  fire-and-forget for non-fiscal document types; block only for
  invoices/receipts where auditors need the guarantee.

## Non-goals

- Template versioning itself — handled by `document_templates.version`
  which is already snapshotted into each artifact row.
- Fiscal signing — handled by `fiscal_transmissions` /
  `etims_transmission_logs`. Artifacts reference the transmission id
  via `metadata.fiscal_transmission_id`.
- Reprint UX — the history panel component (`DocumentHistoryPanel`)
  lands with Wave B3.4.
