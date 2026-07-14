-- pgTAP — delivery-note hardening invariants (re-audit 2026-05-17)
--
-- Covers DB-level guarantees that the React/edge layer relies on but cannot
-- itself enforce. A future migration that drops the trigger, guard, or
-- over-delivery cap will fail this suite.
--
-- Run with:  select * from runtests('public'::name);  (after `create extension pgtap;`)

BEGIN;

SELECT plan(22);

-- ------------------------------------------------------------------
-- I1. _dn_source_invoice_business_match trigger exists and is wired
-- ------------------------------------------------------------------
SELECT has_trigger(
  'public', 'delivery_notes', 'enforce_dn_source_invoice_business_match',
  'Business-match trigger guards source_invoice_id cross-tenant writes'
);

-- ------------------------------------------------------------------
-- I2. complete_delivery_atomic rejects UUID-shaped p_received_by (22023)
-- ------------------------------------------------------------------
SELECT throws_ok(
  $$ SELECT public.complete_delivery_atomic(
       '00000000-0000-0000-0000-000000000001'::uuid,
       '00000000-0000-0000-0000-000000000002'::uuid,
       '87b86b09-fdf8-43af-a209-590c4d6b1415',
       NULL, NULL
     ) $$,
  '22023',
  NULL,
  'complete_delivery_atomic refuses a UUID in p_received_by'
);

-- ------------------------------------------------------------------
-- I3. confirm_invoice_atomic auto-DN insert references received_by_contact_id
--     (we can introspect the function body — cheap proxy for end-to-end run)
-- ------------------------------------------------------------------
SELECT ok(
  (SELECT pg_get_functiondef(p.oid) LIKE '%received_by_contact_id%'
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='confirm_invoice_atomic'),
  'confirm_invoice_atomic stamps received_by_contact_id on auto-DN'
);

-- ------------------------------------------------------------------
-- I4. complete_delivery_atomic enforces per-product over-delivery cap
--     (introspection: function body references the cap clause)
-- ------------------------------------------------------------------
SELECT ok(
  (SELECT pg_get_functiondef(p.oid) LIKE '%Over-delivery blocked%'
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname='public' AND p.proname='complete_delivery_atomic'),
  'complete_delivery_atomic enforces per-product over-delivery cap vs invoice'
);

-- ------------------------------------------------------------------
-- Round 4 — new invariants
-- ------------------------------------------------------------------

-- I5. The legacy 4-arg complete_delivery_atomic overload is gone.
SELECT is(
  (SELECT count(*)::int
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='complete_delivery_atomic'
      AND pg_get_function_arguments(p.oid) = 'p_dn_id uuid, p_user_id uuid, p_received_by text DEFAULT NULL::text, p_pod jsonb DEFAULT NULL::jsonb'),
  0,
  'Legacy 4-arg complete_delivery_atomic overload has been dropped'
);

-- I6. create_invoice_from_delivery_atomic exists and is idempotent on spawned_invoice_id.
SELECT ok(
  (SELECT pg_get_functiondef(p.oid) LIKE '%already_existed%'
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='create_invoice_from_delivery_atomic'),
  'create_invoice_from_delivery_atomic returns already_existed when spawned_invoice_id is set'
);

-- I7. CHECK constraint banning internal automation tokens in delivery_notes.notes.
SELECT ok(
  EXISTS (SELECT 1 FROM pg_constraint WHERE conname='delivery_notes_notes_no_system_tokens'),
  'delivery_notes.notes rejects [auto-from-invoice:UUID] tokens'
);

-- I8. cancel_delivery_atomic exists with the documented signature.
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
     WHERE n.nspname='public' AND p.proname='cancel_delivery_atomic'
       AND pg_get_function_arguments(p.oid) LIKE '%p_reason text%'
  ),
  'cancel_delivery_atomic(uuid,uuid,text) exists'
);

-- I9. cancel_delivery_atomic body refuses to cancel when spawned invoice is past draft.
SELECT ok(
  (SELECT pg_get_functiondef(p.oid) LIKE '%not draft — reverse the invoice first%'
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='cancel_delivery_atomic'),
  'cancel_delivery_atomic blocks when spawned invoice is posted/paid'
);

-- ------------------------------------------------------------------
-- Round 5 — ADR 0026: snapshotting, single COGS locus, reservation
-- symmetry, universal over-delivery cap, first-class return delivery.
-- ------------------------------------------------------------------

-- I10. delivery_note_items carries the point-in-time product snapshot columns.
SELECT has_column('public','delivery_note_items','product_name_snapshot',
  'delivery_note_items.product_name_snapshot exists (frozen product name)');
SELECT has_column('public','delivery_note_items','cost_at_shipment',
  'delivery_note_items.cost_at_shipment exists (frozen COGS cost)');

-- I11. The auto-fill trigger freezes snapshots regardless of inserter.
SELECT has_trigger('public','delivery_note_items','trg_dni_fill_product_snapshots',
  'BEFORE INSERT trigger auto-fills product snapshots on delivery_note_items');

-- I12. Exactly one confirm_invoice_and_release_stock_atomic overload survives
--      (collapsed in ADR 0026 to prevent signature ambiguity / regressions).
SELECT is(
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='confirm_invoice_and_release_stock_atomic'),
  1,
  'Exactly one confirm_invoice_and_release_stock_atomic overload exists'
);

-- I13. That overload must NOT reference the removed p_cogs_lines argument
--      (guards against the 4-arg confirm_invoice_atomic regression recurring).
SELECT ok(
  (SELECT pg_get_functiondef(p.oid) NOT LIKE '%p_cogs_lines%'
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='confirm_invoice_and_release_stock_atomic'),
  'confirm_invoice_and_release_stock_atomic no longer references p_cogs_lines'
);

-- I13b. confirm_invoice_atomic is the canonical 3-arg form (no COGS param).
SELECT is(
  (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='confirm_invoice_atomic'
      AND pg_get_function_arguments(p.oid) NOT LIKE '%p_cogs_lines%'),
  1,
  'confirm_invoice_atomic is single 3-arg overload with no p_cogs_lines'
);

-- I14. restore_so_reservation (symmetric inverse of consume_so_reservation) exists.
SELECT ok(
  EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname='restore_so_reservation'),
  'restore_so_reservation exists for reservation-restore symmetry'
);

-- I15. First-class return delivery: function + linkage column present.
SELECT ok(
  EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
           WHERE n.nspname='public' AND p.proname='create_return_delivery_atomic'),
  'create_return_delivery_atomic exists (first-class return DN)'
);
SELECT has_column('public','delivery_notes','return_of_dn_id',
  'delivery_notes.return_of_dn_id links a return DN to its original');

-- I16. complete_delivery_atomic enforces the SO-sourced over-delivery cap.
SELECT ok(
  (SELECT pg_get_functiondef(p.oid) LIKE '%would exceed SO%'
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='complete_delivery_atomic'),
  'complete_delivery_atomic enforces SO-sourced over-delivery cap'
);

-- I17. complete_delivery_atomic persists cost_at_shipment at goods-issue.
SELECT ok(
  (SELECT pg_get_functiondef(p.oid) LIKE '%cost_at_shipment%'
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='complete_delivery_atomic'),
  'complete_delivery_atomic persists cost_at_shipment for recoverable COGS'
);

-- I18. Return GL is symmetric (COGS reversal subtype on return deliveries).
SELECT ok(
  (SELECT pg_get_functiondef(p.oid) LIKE '%cogs_reversal%'
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='complete_delivery_atomic'),
  'complete_delivery_atomic posts symmetric cogs_reversal GL for returns'
);

-- I19. Fiscal enqueue must honor the canonical outbox schema. The outbox is
-- organization-scoped; business context belongs in payload, not a physical
-- business_id column. This guards invoice confirmation from failing inside the
-- fiscal side-effect when the outbox contract drifts.
SELECT ok(
  (SELECT pg_get_functiondef(p.oid) NOT LIKE '%business_id,%'
      AND pg_get_functiondef(p.oid) LIKE '%jsonb_build_object%business_id%'
     FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public'
      AND p.proname='enqueue_fiscal_receipt_required'
      AND pg_get_function_identity_arguments(p.oid) = 'p_org_id uuid, p_business_id uuid, p_branch_id uuid, p_source_doc_type text, p_source_doc_id uuid, p_document_kind text, p_payload jsonb'),
  'enqueue_fiscal_receipt_required writes business scope into payload, not obsolete outbox.business_id'
);

SELECT * FROM finish();
ROLLBACK;
