INSERT INTO public.journal_books (organization_id, business_id, code, name, journal_type, is_system, description)
SELECT b.organization_id, b.id, 'LND', 'Lending Journal', 'lending', true,
       'Loan disbursements, repayments, write-offs and collection banking'
FROM public.businesses b
ON CONFLICT (business_id, code) DO NOTHING;
-- Rollback: DELETE FROM public.journal_books WHERE code = 'LND';