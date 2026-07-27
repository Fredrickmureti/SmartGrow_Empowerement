/**
 * Wave 7.1.5 — Snapshot builders (kind → JSON blob the renderer expects).
 *
 * Each builder converts a source entity (POS transaction, invoice, bill, …)
 * into the exact shape that the shared rendering engine
 * (`supabase/functions/_shared/rendering/*`) reads out of
 * `document_records.snapshot`.
 *
 * Callers should:
 *   1. Load the source entity with the module's usual query.
 *   2. Call the matching `buildXSnapshot(...)`.
 *   3. Pass the result to {@link ensureDocumentRecord} as `snapshot`.
 *   4. Pass the returned id to {@link submitDocumentIntent}.
 *
 * Snapshots are FROZEN at submit time — never mutate a snapshot after it
 * lands in `document_records`. Reprints replay the same bytes.
 */
export type SnapshotBlob = Record<string, unknown>;
