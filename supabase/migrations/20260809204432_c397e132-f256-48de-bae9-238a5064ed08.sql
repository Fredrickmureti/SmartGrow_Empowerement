COMMENT ON VIEW public.v_invoice_creditable_qty IS
  'Per invoice line: invoiced quantity net of everything already credited by non-void credit notes. Credit-side analogue of v_sales_returnable_qty; re-enforced inside create_credit_note_atomic.';

NOTIFY pgrst, 'reload schema';