-- Add default exchange rates for common currency pairs
-- These are approximate rates that users can customize later

INSERT INTO public.exchange_rates (organization_id, from_currency, to_currency, rate, effective_date)
SELECT 
  o.id,
  'USD',
  'EUR',
  0.92,
  CURRENT_DATE
FROM public.organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM public.exchange_rates er 
  WHERE er.organization_id = o.id 
  AND er.from_currency = 'USD' 
  AND er.to_currency = 'EUR'
);

INSERT INTO public.exchange_rates (organization_id, from_currency, to_currency, rate, effective_date)
SELECT 
  o.id,
  'EUR',
  'USD',
  1.09,
  CURRENT_DATE
FROM public.organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM public.exchange_rates er 
  WHERE er.organization_id = o.id 
  AND er.from_currency = 'EUR' 
  AND er.to_currency = 'USD'
);

INSERT INTO public.exchange_rates (organization_id, from_currency, to_currency, rate, effective_date)
SELECT 
  o.id,
  'USD',
  'GBP',
  0.79,
  CURRENT_DATE
FROM public.organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM public.exchange_rates er 
  WHERE er.organization_id = o.id 
  AND er.from_currency = 'USD' 
  AND er.to_currency = 'GBP'
);

INSERT INTO public.exchange_rates (organization_id, from_currency, to_currency, rate, effective_date)
SELECT 
  o.id,
  'GBP',
  'USD',
  1.27,
  CURRENT_DATE
FROM public.organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM public.exchange_rates er 
  WHERE er.organization_id = o.id 
  AND er.from_currency = 'GBP' 
  AND er.to_currency = 'USD'
);

INSERT INTO public.exchange_rates (organization_id, from_currency, to_currency, rate, effective_date)
SELECT 
  o.id,
  'USD',
  'KES',
  154.50,
  CURRENT_DATE
FROM public.organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM public.exchange_rates er 
  WHERE er.organization_id = o.id 
  AND er.from_currency = 'USD' 
  AND er.to_currency = 'KES'
);

INSERT INTO public.exchange_rates (organization_id, from_currency, to_currency, rate, effective_date)
SELECT 
  o.id,
  'KES',
  'USD',
  0.00647,
  CURRENT_DATE
FROM public.organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM public.exchange_rates er 
  WHERE er.organization_id = o.id 
  AND er.from_currency = 'KES' 
  AND er.to_currency = 'USD'
);

INSERT INTO public.exchange_rates (organization_id, from_currency, to_currency, rate, effective_date)
SELECT 
  o.id,
  'EUR',
  'KES',
  168.00,
  CURRENT_DATE
FROM public.organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM public.exchange_rates er 
  WHERE er.organization_id = o.id 
  AND er.from_currency = 'EUR' 
  AND er.to_currency = 'KES'
);

INSERT INTO public.exchange_rates (organization_id, from_currency, to_currency, rate, effective_date)
SELECT 
  o.id,
  'KES',
  'EUR',
  0.00595,
  CURRENT_DATE
FROM public.organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM public.exchange_rates er 
  WHERE er.organization_id = o.id 
  AND er.from_currency = 'KES' 
  AND er.to_currency = 'EUR'
);

INSERT INTO public.exchange_rates (organization_id, from_currency, to_currency, rate, effective_date)
SELECT 
  o.id,
  'GBP',
  'KES',
  196.00,
  CURRENT_DATE
FROM public.organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM public.exchange_rates er 
  WHERE er.organization_id = o.id 
  AND er.from_currency = 'GBP' 
  AND er.to_currency = 'KES'
);

INSERT INTO public.exchange_rates (organization_id, from_currency, to_currency, rate, effective_date)
SELECT 
  o.id,
  'KES',
  'GBP',
  0.0051,
  CURRENT_DATE
FROM public.organizations o
WHERE NOT EXISTS (
  SELECT 1 FROM public.exchange_rates er 
  WHERE er.organization_id = o.id 
  AND er.from_currency = 'KES' 
  AND er.to_currency = 'GBP'
);