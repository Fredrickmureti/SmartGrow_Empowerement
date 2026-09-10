DROP TRIGGER IF EXISTS trg_expenses_supplier_purchasable ON public.expenses;
DROP FUNCTION IF EXISTS public._tg_assert_supplier_purchasable();