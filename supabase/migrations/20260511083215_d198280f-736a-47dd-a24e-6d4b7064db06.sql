
CREATE TABLE IF NOT EXISTS public.pos_receipt_snapshots (
  transaction_id  uuid PRIMARY KEY REFERENCES public.pos_transactions(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL,
  business_id     uuid NOT NULL,
  branch_id       uuid,
  schema_version  int  NOT NULL DEFAULT 1,
  payload         jsonb NOT NULL,
  rendered_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pos_receipt_snapshots_org_business
  ON public.pos_receipt_snapshots(organization_id, business_id);
CREATE INDEX IF NOT EXISTS idx_pos_receipt_snapshots_branch
  ON public.pos_receipt_snapshots(branch_id);

ALTER TABLE public.pos_receipt_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pos_receipt_snapshots_select ON public.pos_receipt_snapshots;
CREATE POLICY pos_receipt_snapshots_select
  ON public.pos_receipt_snapshots
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.user_roles ur
       WHERE ur.user_id = auth.uid()
         AND ur.organization_id = pos_receipt_snapshots.organization_id
         AND ur.is_active = true
    )
    AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
  );

CREATE OR REPLACE FUNCTION public._pos_build_receipt_snapshot(p_tx_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH tx AS (
    SELECT * FROM public.pos_transactions WHERE id = p_tx_id
  ),
  items AS (
    SELECT jsonb_agg(jsonb_build_object(
      'id', ti.id,
      'product_id', ti.product_id,
      'description', ti.description,
      'quantity', ti.quantity,
      'unit_price', ti.unit_price,
      'discount_type', ti.discount_type,
      'discount_value', ti.discount_value,
      'tax_rate', ti.tax_rate,
      'tax_amount', ti.tax_amount,
      'line_total', ti.line_total,
      'sort_order', ti.sort_order,
      'cost_price', ti.cost_price,
      'etims_tax_code', ti.etims_tax_code
    ) ORDER BY ti.sort_order, ti.id) AS items
    FROM public.pos_transaction_items ti
    WHERE ti.transaction_id = p_tx_id
  ),
  payments AS (
    SELECT jsonb_agg(jsonb_build_object(
      'id', tp.id,
      'payment_method', tp.payment_method,
      'amount', tp.amount,
      'reference', tp.reference,
      'created_at', tp.created_at
    ) ORDER BY tp.created_at) AS payments
    FROM public.pos_transaction_payments tp
    WHERE tp.transaction_id = p_tx_id
  ),
  business AS (
    SELECT to_jsonb(b.*) AS business, b.receipt_settings AS biz_receipt_settings
    FROM tx JOIN public.businesses b ON b.id = tx.business_id
  ),
  branch AS (
    SELECT to_jsonb(br.*) AS branch
    FROM tx LEFT JOIN public.branches br ON br.id = tx.branch_id
  ),
  org AS (
    SELECT to_jsonb(o.*) AS organization
    FROM tx JOIN public.organizations o ON o.id = tx.organization_id
  ),
  customer AS (
    SELECT to_jsonb(c.*) AS customer
    FROM tx LEFT JOIN public.contacts c ON c.id = tx.customer_id
  ),
  cashier AS (
    SELECT jsonb_build_object(
      'id', tx.cashier_id,
      'name', p.full_name,
      'email', p.email
    ) AS cashier
    FROM tx LEFT JOIN public.profiles p ON p.id = tx.cashier_id
  ),
  register AS (
    SELECT to_jsonb(r.*) AS register
    FROM tx LEFT JOIN public.pos_registers r ON r.id = tx.register_id
  ),
  reg_settings AS (
    SELECT ps.setting_value AS register_receipt_settings
    FROM tx
    LEFT JOIN public.pos_settings ps
      ON ps.register_id = tx.register_id
     AND ps.setting_key = 'receipt_settings'
    LIMIT 1
  )
  SELECT jsonb_build_object(
    'schema_version', 1,
    'transaction', to_jsonb(tx.*),
    'items',       COALESCE(items.items, '[]'::jsonb),
    'payments',    COALESCE(payments.payments, '[]'::jsonb),
    'business',    business.business,
    'branch',      branch.branch,
    'organization', org.organization,
    'customer',    customer.customer,
    'cashier',     cashier.cashier,
    'register',    register.register,
    'business_receipt_settings', business.biz_receipt_settings,
    'register_receipt_settings', reg_settings.register_receipt_settings
  )
  FROM tx, items, payments, business, branch, org, customer, cashier, register, reg_settings;
$$;

CREATE OR REPLACE FUNCTION public._pos_write_receipt_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payload jsonb;
BEGIN
  IF NEW.transaction_type IS NULL THEN
    RETURN NEW;
  END IF;

  v_payload := public._pos_build_receipt_snapshot(NEW.id);
  IF v_payload IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.pos_receipt_snapshots(
    transaction_id, organization_id, business_id, branch_id, payload
  ) VALUES (
    NEW.id, NEW.organization_id, NEW.business_id, NEW.branch_id, v_payload
  )
  ON CONFLICT (transaction_id) DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pos_write_receipt_snapshot ON public.pos_transactions;
CREATE CONSTRAINT TRIGGER trg_pos_write_receipt_snapshot
  AFTER INSERT ON public.pos_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public._pos_write_receipt_snapshot();

COMMENT ON TABLE public.pos_receipt_snapshots IS
  'Stage B: frozen receipt payload at sale time. Reprints (client preview + edge PDF) MUST prefer this over live product/template/branding lookups.';

COMMENT ON FUNCTION public._pos_build_receipt_snapshot(uuid) IS
  'Stage B: gathers all data needed to re-render a receipt without any current-state lookups. Stores both raw receipt-settings rows (business + register) so the renderer applies the same merge as useMergedReceiptSettings.';
