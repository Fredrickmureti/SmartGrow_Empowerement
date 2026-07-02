-- Add voiding/reversal support columns to payments table
ALTER TABLE public.payments
ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'applied' CHECK (status IN ('applied', 'voided', 'unreconciled')),
ADD COLUMN IF NOT EXISTS voided_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS voided_by UUID,
ADD COLUMN IF NOT EXISTS void_reason TEXT,
ADD COLUMN IF NOT EXISTS unreconciled_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS unreconciled_by UUID,
ADD COLUMN IF NOT EXISTS unreconcile_reason TEXT,
ADD COLUMN IF NOT EXISTS reapplied_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS reapplied_by UUID,
ADD COLUMN IF NOT EXISTS reapply_reason TEXT;

-- Add voiding support columns to invoices table
ALTER TABLE public.invoices
ADD COLUMN IF NOT EXISTS voided_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN IF NOT EXISTS voided_by UUID,
ADD COLUMN IF NOT EXISTS void_reason TEXT;

-- Update invoice status enum to include 'voided' if not already present
-- First, we need to check the constraint and update it
DO $$
BEGIN
  -- Drop existing constraint if it exists
  IF EXISTS (
    SELECT 1 FROM information_schema.check_constraints 
    WHERE constraint_name = 'invoices_status_check'
  ) THEN
    ALTER TABLE public.invoices DROP CONSTRAINT invoices_status_check;
  END IF;
  
  -- Add new constraint with voided status
  ALTER TABLE public.invoices 
  ADD CONSTRAINT invoices_status_check 
  CHECK (status IN ('draft', 'sent', 'viewed', 'partial', 'paid', 'overdue', 'cancelled', 'voided'));
EXCEPTION
  WHEN OTHERS THEN
    -- If the column is already an enum or doesn't have a constraint, just continue
    NULL;
END $$;

-- Add credit note linking columns for void & duplicate workflow
ALTER TABLE public.credit_notes
ADD COLUMN IF NOT EXISTS original_invoice_id UUID REFERENCES public.invoices(id);

-- Create index for faster lookups on voided transactions
CREATE INDEX IF NOT EXISTS idx_payments_status ON public.payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_voided_at ON public.payments(voided_at) WHERE voided_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_invoices_voided_at ON public.invoices(voided_at) WHERE voided_at IS NOT NULL;

-- Add comments for documentation
COMMENT ON COLUMN public.payments.status IS 'Payment status: applied (normal), voided (reversed), unreconciled (detached from invoice)';
COMMENT ON COLUMN public.payments.void_reason IS 'Reason for voiding the payment';
COMMENT ON COLUMN public.invoices.voided_at IS 'Timestamp when invoice was voided';
COMMENT ON COLUMN public.invoices.void_reason IS 'Reason for voiding the invoice';