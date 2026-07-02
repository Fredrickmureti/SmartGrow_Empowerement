
-- Create junction table for vendor credit note applications to bills
-- This replaces the single bill_id column approach which loses data on multi-bill applications
CREATE TABLE public.vendor_credit_note_applications (
    id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    credit_note_id UUID NOT NULL REFERENCES public.vendor_credit_notes(id) ON DELETE CASCADE,
    bill_id UUID NOT NULL REFERENCES public.bills(id) ON DELETE CASCADE,
    amount NUMERIC NOT NULL CHECK (amount > 0),
    applied_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
    applied_by UUID REFERENCES auth.users(id),
    organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

-- Indexes for common lookups
CREATE INDEX idx_vcn_applications_credit_note ON public.vendor_credit_note_applications(credit_note_id);
CREATE INDEX idx_vcn_applications_bill ON public.vendor_credit_note_applications(bill_id);
CREATE INDEX idx_vcn_applications_org ON public.vendor_credit_note_applications(organization_id);

-- Enable RLS
ALTER TABLE public.vendor_credit_note_applications ENABLE ROW LEVEL SECURITY;

-- RLS policies matching the org-based pattern used by vendor_credit_notes and bills
CREATE POLICY "Users can view VCN applications in their org"
ON public.vendor_credit_note_applications
FOR SELECT
TO authenticated
USING (
    organization_id IN (
        SELECT organization_id FROM public.profiles WHERE id = auth.uid()
    )
);

CREATE POLICY "Users can create VCN applications in their org"
ON public.vendor_credit_note_applications
FOR INSERT
TO authenticated
WITH CHECK (
    organization_id IN (
        SELECT organization_id FROM public.profiles WHERE id = auth.uid()
    )
);

CREATE POLICY "Users can update VCN applications in their org"
ON public.vendor_credit_note_applications
FOR UPDATE
TO authenticated
USING (
    organization_id IN (
        SELECT organization_id FROM public.profiles WHERE id = auth.uid()
    )
);

CREATE POLICY "Users can delete VCN applications in their org"
ON public.vendor_credit_note_applications
FOR DELETE
TO authenticated
USING (
    organization_id IN (
        SELECT organization_id FROM public.profiles WHERE id = auth.uid()
    )
);

-- Atomic VCN number generation RPC (mirrors get_next_bill_number pattern)
CREATE OR REPLACE FUNCTION public.get_next_vendor_credit_note_number(p_organization_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_next_num INT;
    v_result TEXT;
BEGIN
    -- Get max existing number
    SELECT COALESCE(
        MAX(
            CASE
                WHEN credit_note_number ~ '^VCN-[0-9]+$'
                THEN CAST(SUBSTRING(credit_note_number FROM 'VCN-([0-9]+)') AS INT)
                ELSE 0
            END
        ), 0
    ) + 1
    INTO v_next_num
    FROM public.vendor_credit_notes
    WHERE organization_id = p_organization_id;

    v_result := 'VCN-' || LPAD(v_next_num::TEXT, 3, '0');
    RETURN v_result;
END;
$$;
