-- Backfill pos_receipt_snapshots: rebuild payload for any snapshot whose
-- payload predates schema_version 5 (the version that added multi-unit
-- pack provenance: display_quantity, packaging_label, base_uom_label,
-- uom_snapshot). Without this, PDF/A4 reprints of older POS receipts
-- silently print base units (e.g. "20") instead of the transaction unit
-- ("2 Strip"), even though the ESC/POS path now renders correctly.
UPDATE public.pos_receipt_snapshots s
SET payload = public._pos_build_receipt_snapshot(s.transaction_id)
WHERE COALESCE((s.payload->>'schema_version')::int, 0) < 5;