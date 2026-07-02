-- STAGE R1: columns + indexes
ALTER TABLE public.payments              ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id);
ALTER TABLE public.bill_payments         ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id);
ALTER TABLE public.payment_allocations   ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id);
ALTER TABLE public.credit_notes          ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id);
ALTER TABLE public.customer_statements   ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id);
ALTER TABLE public.purchase_orders       ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id);
ALTER TABLE public.goods_receipts        ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id);
ALTER TABLE public.goods_receipt_items   ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id);
ALTER TABLE public.payroll_runs          ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id);
ALTER TABLE public.payslips              ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id);
ALTER TABLE public.pos_sessions          ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id);
ALTER TABLE public.pos_transaction_items ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id);
ALTER TABLE public.pos_transaction_payments ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id);
ALTER TABLE public.stock_movements       ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id);
ALTER TABLE public.stock_adjustments     ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id);
ALTER TABLE public.stock_adjustment_items ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id);
ALTER TABLE public.stock_transfers       ADD COLUMN IF NOT EXISTS from_branch_id uuid REFERENCES public.branches(id);
ALTER TABLE public.stock_transfers       ADD COLUMN IF NOT EXISTS to_branch_id   uuid REFERENCES public.branches(id);
ALTER TABLE public.stock_transfer_items  ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES public.branches(id);

CREATE INDEX IF NOT EXISTS idx_payments_branch_id              ON public.payments(branch_id);
CREATE INDEX IF NOT EXISTS idx_bill_payments_branch_id         ON public.bill_payments(branch_id);
CREATE INDEX IF NOT EXISTS idx_payment_allocations_branch_id   ON public.payment_allocations(branch_id);
CREATE INDEX IF NOT EXISTS idx_credit_notes_branch_id          ON public.credit_notes(branch_id);
CREATE INDEX IF NOT EXISTS idx_customer_statements_branch_id   ON public.customer_statements(branch_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_branch_id       ON public.purchase_orders(branch_id);
CREATE INDEX IF NOT EXISTS idx_goods_receipts_branch_id        ON public.goods_receipts(branch_id);
CREATE INDEX IF NOT EXISTS idx_goods_receipt_items_branch_id   ON public.goods_receipt_items(branch_id);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_branch_id          ON public.payroll_runs(branch_id);
CREATE INDEX IF NOT EXISTS idx_payslips_branch_id              ON public.payslips(branch_id);
CREATE INDEX IF NOT EXISTS idx_pos_sessions_branch_id          ON public.pos_sessions(branch_id);
CREATE INDEX IF NOT EXISTS idx_pos_transaction_items_branch_id ON public.pos_transaction_items(branch_id);
CREATE INDEX IF NOT EXISTS idx_pos_transaction_payments_branch_id ON public.pos_transaction_payments(branch_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_branch_id       ON public.stock_movements(branch_id);
CREATE INDEX IF NOT EXISTS idx_stock_adjustments_branch_id     ON public.stock_adjustments(branch_id);
CREATE INDEX IF NOT EXISTS idx_stock_adjustment_items_branch_id ON public.stock_adjustment_items(branch_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_from_branch_id  ON public.stock_transfers(from_branch_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfers_to_branch_id    ON public.stock_transfers(to_branch_id);
CREATE INDEX IF NOT EXISTS idx_stock_transfer_items_branch_id  ON public.stock_transfer_items(branch_id);

CREATE OR REPLACE FUNCTION public._pick_hq_branch(_business_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM public.branches WHERE business_id = _business_id
   ORDER BY is_headquarters DESC NULLS LAST, created_at ASC LIMIT 1
$$;

-- BACKFILL
UPDATE public.payments p SET branch_id = COALESCE(i.branch_id, public._pick_hq_branch(p.business_id))
  FROM public.invoices i WHERE p.invoice_id = i.id AND p.branch_id IS NULL;
UPDATE public.payments SET branch_id = public._pick_hq_branch(business_id) WHERE branch_id IS NULL;

UPDATE public.bill_payments bp SET branch_id = COALESCE(b.branch_id, public._pick_hq_branch(bp.business_id))
  FROM public.bills b WHERE bp.bill_id = b.id AND bp.branch_id IS NULL;
UPDATE public.bill_payments SET branch_id = public._pick_hq_branch(business_id) WHERE branch_id IS NULL;

UPDATE public.payment_allocations pa SET branch_id = i.branch_id
  FROM public.invoices i WHERE pa.invoice_id = i.id AND pa.branch_id IS NULL;

UPDATE public.credit_notes cn SET branch_id = COALESCE(i.branch_id, public._pick_hq_branch(cn.business_id))
  FROM public.invoices i WHERE cn.invoice_id = i.id AND cn.branch_id IS NULL;
UPDATE public.credit_notes SET branch_id = public._pick_hq_branch(business_id) WHERE branch_id IS NULL;

UPDATE public.customer_statements SET branch_id = public._pick_hq_branch(business_id) WHERE branch_id IS NULL;
UPDATE public.purchase_orders     SET branch_id = public._pick_hq_branch(business_id) WHERE branch_id IS NULL;

UPDATE public.goods_receipts gr SET branch_id = COALESCE(po.branch_id, public._pick_hq_branch(gr.business_id))
  FROM public.purchase_orders po WHERE gr.purchase_order_id = po.id AND gr.branch_id IS NULL;
UPDATE public.goods_receipts SET branch_id = public._pick_hq_branch(business_id) WHERE branch_id IS NULL;

UPDATE public.goods_receipt_items gri SET branch_id = gr.branch_id
  FROM public.goods_receipts gr WHERE gri.goods_receipt_id = gr.id AND gri.branch_id IS NULL;

UPDATE public.payroll_runs SET branch_id = public._pick_hq_branch(business_id) WHERE branch_id IS NULL;

UPDATE public.payslips ps SET branch_id = COALESCE(
    (SELECT branch_id FROM public.employees    WHERE id = ps.employee_id),
    (SELECT branch_id FROM public.payroll_runs WHERE id = ps.payroll_run_id),
    public._pick_hq_branch(ps.business_id)
  ) WHERE ps.branch_id IS NULL;

UPDATE public.pos_sessions s SET branch_id = COALESCE(r.branch_id, public._pick_hq_branch(s.business_id))
  FROM public.pos_registers r WHERE s.register_id = r.id AND s.branch_id IS NULL;
UPDATE public.pos_sessions SET branch_id = public._pick_hq_branch(business_id) WHERE branch_id IS NULL;

UPDATE public.pos_transaction_items pti SET branch_id = t.branch_id
  FROM public.pos_transactions t WHERE pti.transaction_id = t.id AND pti.branch_id IS NULL;
UPDATE public.pos_transaction_payments ptp SET branch_id = t.branch_id
  FROM public.pos_transactions t WHERE ptp.transaction_id = t.id AND ptp.branch_id IS NULL;

UPDATE public.stock_movements sm SET branch_id = COALESCE(w.branch_id, public._pick_hq_branch(sm.business_id))
  FROM public.warehouses w WHERE sm.warehouse_id = w.id AND sm.branch_id IS NULL;
UPDATE public.stock_movements SET branch_id = public._pick_hq_branch(business_id) WHERE branch_id IS NULL;

UPDATE public.stock_adjustments SET branch_id = public._pick_hq_branch(business_id) WHERE branch_id IS NULL;

UPDATE public.stock_adjustment_items sai SET branch_id = sa.branch_id
  FROM public.stock_adjustments sa WHERE sai.adjustment_id = sa.id AND sai.branch_id IS NULL;

UPDATE public.stock_transfers st SET from_branch_id = COALESCE(wf.branch_id, public._pick_hq_branch(st.business_id))
  FROM public.warehouses wf WHERE st.from_warehouse_id = wf.id AND st.from_branch_id IS NULL;
UPDATE public.stock_transfers st SET to_branch_id = COALESCE(wt.branch_id, public._pick_hq_branch(st.business_id))
  FROM public.warehouses wt WHERE st.to_warehouse_id = wt.id AND st.to_branch_id IS NULL;
UPDATE public.stock_transfers SET from_branch_id = public._pick_hq_branch(business_id) WHERE from_branch_id IS NULL;
UPDATE public.stock_transfers SET to_branch_id   = public._pick_hq_branch(business_id) WHERE to_branch_id   IS NULL;

UPDATE public.stock_transfer_items sti SET branch_id = st.from_branch_id
  FROM public.stock_transfers st WHERE sti.transfer_id = st.id AND sti.branch_id IS NULL;

-- STAGE R2: enforce_branch_business_match on tables that have BOTH branch_id and business_id
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'payments','bill_payments','credit_notes','customer_statements',
    'purchase_orders','goods_receipts','payroll_runs','payslips',
    'pos_sessions','stock_movements','stock_adjustments'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format(
      'DROP TRIGGER IF EXISTS trg_%I_branch_business_match ON public.%I;
       CREATE TRIGGER trg_%I_branch_business_match
       BEFORE INSERT OR UPDATE OF branch_id, business_id ON public.%I
       FOR EACH ROW EXECUTE FUNCTION public.enforce_branch_business_match();',
       t, t, t, t);
  END LOOP;
END$$;

CREATE OR REPLACE FUNCTION public.enforce_stock_transfer_branches_match()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE fb_biz uuid; tb_biz uuid;
BEGIN
  IF NEW.from_branch_id IS NOT NULL THEN
    SELECT business_id INTO fb_biz FROM public.branches WHERE id = NEW.from_branch_id;
    IF fb_biz IS DISTINCT FROM NEW.business_id THEN
      RAISE EXCEPTION 'stock_transfers.from_branch_id % does not belong to business_id %',
        NEW.from_branch_id, NEW.business_id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.to_branch_id IS NOT NULL THEN
    SELECT business_id INTO tb_biz FROM public.branches WHERE id = NEW.to_branch_id;
    IF tb_biz IS DISTINCT FROM NEW.business_id THEN
      RAISE EXCEPTION 'stock_transfers.to_branch_id % does not belong to business_id %',
        NEW.to_branch_id, NEW.business_id USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS trg_stock_transfers_branches_match ON public.stock_transfers;
CREATE TRIGGER trg_stock_transfers_branches_match
BEFORE INSERT OR UPDATE OF from_branch_id, to_branch_id, business_id ON public.stock_transfers
FOR EACH ROW EXECUTE FUNCTION public.enforce_stock_transfer_branches_match();

-- STAGE R3: child cascade triggers (auto-fill branch_id from parent)
CREATE OR REPLACE FUNCTION public.cascade_branch_from_pos_transaction()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.branch_id IS NULL AND NEW.transaction_id IS NOT NULL THEN
    SELECT branch_id INTO NEW.branch_id FROM public.pos_transactions WHERE id = NEW.transaction_id;
  END IF;
  RETURN NEW;
END$$;

CREATE OR REPLACE FUNCTION public.cascade_branch_from_goods_receipt()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.branch_id IS NULL AND NEW.goods_receipt_id IS NOT NULL THEN
    SELECT branch_id INTO NEW.branch_id FROM public.goods_receipts WHERE id = NEW.goods_receipt_id;
  END IF;
  RETURN NEW;
END$$;

CREATE OR REPLACE FUNCTION public.cascade_branch_from_stock_adjustment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.branch_id IS NULL AND NEW.adjustment_id IS NOT NULL THEN
    SELECT branch_id INTO NEW.branch_id FROM public.stock_adjustments WHERE id = NEW.adjustment_id;
  END IF;
  RETURN NEW;
END$$;

CREATE OR REPLACE FUNCTION public.cascade_branch_from_stock_transfer()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.branch_id IS NULL AND NEW.transfer_id IS NOT NULL THEN
    SELECT from_branch_id INTO NEW.branch_id FROM public.stock_transfers WHERE id = NEW.transfer_id;
  END IF;
  RETURN NEW;
END$$;

CREATE OR REPLACE FUNCTION public.cascade_branch_from_payroll_run()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.branch_id IS NULL AND NEW.payroll_run_id IS NOT NULL THEN
    SELECT branch_id INTO NEW.branch_id FROM public.payroll_runs WHERE id = NEW.payroll_run_id;
  END IF;
  RETURN NEW;
END$$;

CREATE OR REPLACE FUNCTION public.cascade_branch_from_invoice()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.branch_id IS NULL AND NEW.invoice_id IS NOT NULL THEN
    SELECT branch_id INTO NEW.branch_id FROM public.invoices WHERE id = NEW.invoice_id;
  END IF;
  RETURN NEW;
END$$;

CREATE OR REPLACE FUNCTION public.cascade_branch_from_bill()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.branch_id IS NULL AND NEW.bill_id IS NOT NULL THEN
    SELECT branch_id INTO NEW.branch_id FROM public.bills WHERE id = NEW.bill_id;
  END IF;
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS trg_cascade_branch_pos_transaction_items ON public.pos_transaction_items;
CREATE TRIGGER trg_cascade_branch_pos_transaction_items
BEFORE INSERT ON public.pos_transaction_items
FOR EACH ROW EXECUTE FUNCTION public.cascade_branch_from_pos_transaction();

DROP TRIGGER IF EXISTS trg_cascade_branch_pos_transaction_payments ON public.pos_transaction_payments;
CREATE TRIGGER trg_cascade_branch_pos_transaction_payments
BEFORE INSERT ON public.pos_transaction_payments
FOR EACH ROW EXECUTE FUNCTION public.cascade_branch_from_pos_transaction();

DROP TRIGGER IF EXISTS trg_cascade_branch_goods_receipt_items ON public.goods_receipt_items;
CREATE TRIGGER trg_cascade_branch_goods_receipt_items
BEFORE INSERT ON public.goods_receipt_items
FOR EACH ROW EXECUTE FUNCTION public.cascade_branch_from_goods_receipt();

DROP TRIGGER IF EXISTS trg_cascade_branch_stock_adjustment_items ON public.stock_adjustment_items;
CREATE TRIGGER trg_cascade_branch_stock_adjustment_items
BEFORE INSERT ON public.stock_adjustment_items
FOR EACH ROW EXECUTE FUNCTION public.cascade_branch_from_stock_adjustment();

DROP TRIGGER IF EXISTS trg_cascade_branch_stock_transfer_items ON public.stock_transfer_items;
CREATE TRIGGER trg_cascade_branch_stock_transfer_items
BEFORE INSERT ON public.stock_transfer_items
FOR EACH ROW EXECUTE FUNCTION public.cascade_branch_from_stock_transfer();

DROP TRIGGER IF EXISTS trg_cascade_branch_payslips ON public.payslips;
CREATE TRIGGER trg_cascade_branch_payslips
BEFORE INSERT ON public.payslips
FOR EACH ROW EXECUTE FUNCTION public.cascade_branch_from_payroll_run();

DROP TRIGGER IF EXISTS trg_cascade_branch_payment_allocations ON public.payment_allocations;
CREATE TRIGGER trg_cascade_branch_payment_allocations
BEFORE INSERT ON public.payment_allocations
FOR EACH ROW EXECUTE FUNCTION public.cascade_branch_from_invoice();

DROP TRIGGER IF EXISTS trg_cascade_branch_credit_notes ON public.credit_notes;
CREATE TRIGGER trg_cascade_branch_credit_notes
BEFORE INSERT ON public.credit_notes
FOR EACH ROW EXECUTE FUNCTION public.cascade_branch_from_invoice();

DROP TRIGGER IF EXISTS trg_cascade_branch_payments ON public.payments;
CREATE TRIGGER trg_cascade_branch_payments
BEFORE INSERT ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.cascade_branch_from_invoice();

DROP TRIGGER IF EXISTS trg_cascade_branch_bill_payments ON public.bill_payments;
CREATE TRIGGER trg_cascade_branch_bill_payments
BEFORE INSERT ON public.bill_payments
FOR EACH ROW EXECUTE FUNCTION public.cascade_branch_from_bill();