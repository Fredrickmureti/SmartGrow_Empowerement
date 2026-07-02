-- Trigger: Update accounts.current_balance when journal_entry_lines are inserted or deleted
CREATE OR REPLACE FUNCTION public.update_account_current_balance()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE accounts 
    SET current_balance = COALESCE(current_balance, 0) + COALESCE(NEW.debit, 0) - COALESCE(NEW.credit, 0),
        updated_at = now()
    WHERE id = NEW.account_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE accounts 
    SET current_balance = COALESCE(current_balance, 0) - COALESCE(OLD.debit, 0) + COALESCE(OLD.credit, 0),
        updated_at = now()
    WHERE id = OLD.account_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_update_account_balance ON journal_entry_lines;
CREATE TRIGGER trg_update_account_balance
  AFTER INSERT OR DELETE ON journal_entry_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.update_account_current_balance();

-- Trigger: Update products.stock_quantity when stock_movements are inserted
CREATE OR REPLACE FUNCTION public.update_product_stock_quantity()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE products 
    SET stock_quantity = COALESCE(stock_quantity, 0) + COALESCE(NEW.quantity, 0),
        updated_at = now()
    WHERE id = NEW.product_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE products 
    SET stock_quantity = COALESCE(stock_quantity, 0) - COALESCE(OLD.quantity, 0),
        updated_at = now()
    WHERE id = OLD.product_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_update_product_stock ON stock_movements;
CREATE TRIGGER trg_update_product_stock
  AFTER INSERT OR DELETE ON stock_movements
  FOR EACH ROW
  EXECUTE FUNCTION public.update_product_stock_quantity();