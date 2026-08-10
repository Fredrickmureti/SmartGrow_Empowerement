-- pgTAP — payment-term resolution invariants (Phase 6, 2026-08-09)
--
-- The whole workstream rests on ONE rule: a document's credit period comes
-- from `public.resolve_payment_term(org, business, contact, override)` and
-- from nowhere else. The TypeScript guard
-- (`src/test/architecture/payment-term-single-source.test.ts`) can only prove
-- that the app never hardcodes a period; it cannot prove the cascade itself
-- behaves. This suite proves the database half:
--
--   Tier 1  explicit document override
--   Tier 2  counterparty default (contacts.payment_term_id)
--   Tier 3  business default (payment_terms.is_default AND is_active)
--   Tier 4  nothing -> no row -> caller treats as DUE ON RECEIPT
--
-- plus the BEFORE INSERT fill triggers on invoices / bills / sales_orders,
-- which must populate a null term and must NEVER overwrite an explicit one.
--
-- Run with:  select * from runtests('public'::name);  (after `create extension pgtap;`)
-- Everything happens inside a transaction against real tenant rows and is
-- rolled back; no fixture organization is created.

BEGIN;

SELECT plan(14);

-- ------------------------------------------------------------------
-- Context: first real business, its organization, and one of its contacts.
-- ------------------------------------------------------------------
CREATE TEMP TABLE _ctx AS
SELECT
  b.organization_id AS org,
  b.id              AS biz,
  (SELECT c.id FROM public.contacts c
    WHERE c.organization_id = b.organization_id
    ORDER BY c.created_at LIMIT 1) AS contact
FROM public.businesses b
ORDER BY b.created_at
LIMIT 1;

-- Ephemeral, non-default terms used to exercise tiers 1 and 2.
CREATE TEMP TABLE _terms AS
WITH ins AS (
  INSERT INTO public.payment_terms
    (organization_id, business_id, name, days, is_default, is_active)
  SELECT org, biz, 'PGTAP Party 7', 7, false, true FROM _ctx
  UNION ALL
  SELECT org, biz, 'PGTAP Override 3', 3, false, true FROM _ctx
  UNION ALL
  SELECT org, biz, 'PGTAP Inactive 99', 99, false, false FROM _ctx
  RETURNING id, name, days
)
SELECT * FROM ins;

-- ------------------------------------------------------------------
-- T1. Tier 3 — with neither contact nor override, the business default wins.
-- ------------------------------------------------------------------
SELECT is(
  (SELECT r.days FROM _ctx, LATERAL public.resolve_payment_term(_ctx.org, _ctx.biz, NULL, NULL) r),
  (SELECT pt.days FROM _ctx JOIN public.payment_terms pt
      ON pt.business_id = _ctx.biz AND pt.is_default AND pt.is_active),
  'Tier 3: business default term is resolved when nothing else is set'
);

-- ------------------------------------------------------------------
-- T2. Tier 2 — the counterparty default beats the business default.
-- ------------------------------------------------------------------
UPDATE public.contacts c
   SET payment_term_id = (SELECT id FROM _terms WHERE name = 'PGTAP Party 7')
 WHERE c.id = (SELECT contact FROM _ctx);

SELECT is(
  (SELECT r.days FROM _ctx, LATERAL public.resolve_payment_term(_ctx.org, _ctx.biz, _ctx.contact, NULL) r),
  7,
  'Tier 2: the contact''s own term overrides the business default'
);

-- ------------------------------------------------------------------
-- T3. Tier 1 — an explicit document override beats the contact default.
-- ------------------------------------------------------------------
SELECT is(
  (SELECT r.days FROM _ctx, LATERAL public.resolve_payment_term(
      _ctx.org, _ctx.biz, _ctx.contact,
      (SELECT id FROM _terms WHERE name = 'PGTAP Override 3')) r),
  3,
  'Tier 1: an explicit override wins over every default'
);

-- ------------------------------------------------------------------
-- T4. An INACTIVE term is never resolved, even when passed as the override.
-- ------------------------------------------------------------------
SELECT is(
  (SELECT r.days FROM _ctx, LATERAL public.resolve_payment_term(
      _ctx.org, _ctx.biz, NULL,
      (SELECT id FROM _terms WHERE name = 'PGTAP Inactive 99')) r),
  (SELECT pt.days FROM _ctx JOIN public.payment_terms pt
      ON pt.business_id = _ctx.biz AND pt.is_default AND pt.is_active),
  'An inactive override is ignored and the cascade continues to the default'
);

-- ------------------------------------------------------------------
-- T5. An inactive term on the CONTACT is ignored too.
-- ------------------------------------------------------------------
UPDATE public.contacts c
   SET payment_term_id = (SELECT id FROM _terms WHERE name = 'PGTAP Inactive 99')
 WHERE c.id = (SELECT contact FROM _ctx);

SELECT is(
  (SELECT r.days FROM _ctx, LATERAL public.resolve_payment_term(_ctx.org, _ctx.biz, _ctx.contact, NULL) r),
  (SELECT pt.days FROM _ctx JOIN public.payment_terms pt
      ON pt.business_id = _ctx.biz AND pt.is_default AND pt.is_active),
  'An inactive contact term is ignored and the cascade continues'
);

-- Restore an active contact term for the trigger tests below.
UPDATE public.contacts c
   SET payment_term_id = (SELECT id FROM _terms WHERE name = 'PGTAP Party 7')
 WHERE c.id = (SELECT contact FROM _ctx);

-- ------------------------------------------------------------------
-- T6. Cross-tenant safety — a term is never resolved for another org.
-- ------------------------------------------------------------------
SELECT is_empty(
  $$ SELECT * FROM public.resolve_payment_term(
       '00000000-0000-0000-0000-0000000000ff'::uuid, NULL, NULL, NULL) $$,
  'No term is resolved for an organization that owns none'
);

SELECT is_empty(
  format(
    $$ SELECT * FROM public.resolve_payment_term(
         '00000000-0000-0000-0000-0000000000ff'::uuid, NULL, NULL, %L::uuid) $$,
    (SELECT id FROM _terms WHERE name = 'PGTAP Override 3')),
  'An override belonging to another organization is refused, not borrowed'
);

-- ------------------------------------------------------------------
-- T7. The fill triggers exist on all three document tables.
-- ------------------------------------------------------------------
SELECT has_trigger('public', 'invoices', 'trg_invoices_fill_payment_term',
  'invoices inherit a payment term on insert');
SELECT has_trigger('public', 'bills', 'trg_bills_fill_payment_term',
  'bills inherit a payment term on insert');
SELECT has_trigger('public', 'sales_orders', 'trg_sales_orders_fill_payment_term',
  'sales orders inherit a payment term on insert');

-- ------------------------------------------------------------------
-- T8. Insert with a NULL term -> filled from the cascade (contact tier).
-- ------------------------------------------------------------------
CREATE TEMP TABLE _inv AS
WITH ins AS (
  INSERT INTO public.invoices
    (organization_id, business_id, contact_id, invoice_number, issue_date, due_date)
  SELECT org, biz, contact, 'PGTAP-INV-1', CURRENT_DATE, CURRENT_DATE FROM _ctx
  RETURNING id, payment_term_id
)
SELECT * FROM ins;

SELECT is(
  (SELECT payment_term_id FROM _inv),
  (SELECT id FROM _terms WHERE name = 'PGTAP Party 7'),
  'A null-term invoice inherits the contact''s term on insert'
);

CREATE TEMP TABLE _so AS
WITH ins AS (
  INSERT INTO public.sales_orders
    (organization_id, business_id, contact_id, so_number, order_date)
  SELECT org, biz, contact, 'PGTAP-SO-1', CURRENT_DATE FROM _ctx
  RETURNING id, payment_term_id
)
SELECT * FROM ins;

SELECT is(
  (SELECT payment_term_id FROM _so),
  (SELECT id FROM _terms WHERE name = 'PGTAP Party 7'),
  'A null-term sales order inherits the contact''s term on insert'
);

-- ------------------------------------------------------------------
-- T9. Insert with an EXPLICIT term -> the trigger must not touch it.
-- ------------------------------------------------------------------
CREATE TEMP TABLE _inv2 AS
WITH ins AS (
  INSERT INTO public.invoices
    (organization_id, business_id, contact_id, invoice_number, issue_date, due_date, payment_term_id)
  SELECT org, biz, contact, 'PGTAP-INV-2', CURRENT_DATE, CURRENT_DATE,
         (SELECT id FROM _terms WHERE name = 'PGTAP Override 3')
  FROM _ctx
  RETURNING id, payment_term_id
)
SELECT * FROM ins;

SELECT is(
  (SELECT payment_term_id FROM _inv2),
  (SELECT id FROM _terms WHERE name = 'PGTAP Override 3'),
  'An explicitly chosen term is never overwritten by the fill trigger'
);

-- ------------------------------------------------------------------
-- T10. Tier 4 — no resolvable term at all yields NO ROW (due on receipt).
--      Deliberately last: it deactivates every term in the business.
-- ------------------------------------------------------------------
UPDATE public.contacts SET payment_term_id = NULL WHERE id = (SELECT contact FROM _ctx);
UPDATE public.payment_terms SET is_active = false WHERE business_id = (SELECT biz FROM _ctx);

SELECT is_empty(
  $$ SELECT * FROM public.resolve_payment_term(
       (SELECT org FROM _ctx), (SELECT biz FROM _ctx), (SELECT contact FROM _ctx), NULL) $$,
  'With no active term anywhere the resolver returns nothing (due on receipt)'
);

SELECT * FROM finish();
ROLLBACK;
