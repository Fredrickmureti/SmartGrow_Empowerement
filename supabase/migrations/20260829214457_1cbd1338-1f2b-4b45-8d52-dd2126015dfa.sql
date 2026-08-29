CREATE TABLE IF NOT EXISTS public.iso_currencies (
  code text PRIMARY KEY,
  name text NOT NULL,
  symbol text,
  decimal_places integer NOT NULL DEFAULT 2,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.iso_currencies TO anon;
GRANT SELECT ON public.iso_currencies TO authenticated;
GRANT ALL ON public.iso_currencies TO service_role;

ALTER TABLE public.iso_currencies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ISO currencies are readable by everyone" ON public.iso_currencies;
CREATE POLICY "ISO currencies are readable by everyone"
  ON public.iso_currencies FOR SELECT USING (true);

INSERT INTO public.iso_currencies (code, name, symbol, decimal_places) VALUES
('KES','Kenyan Shilling','KSh',2),
('UGX','Ugandan Shilling','USh',0),
('TZS','Tanzanian Shilling','TSh',2),
('RWF','Rwandan Franc','FRw',0),
('BIF','Burundian Franc','FBu',0),
('ETB','Ethiopian Birr','Br',2),
('SSP','South Sudanese Pound','£',2),
('SOS','Somali Shilling','Sh',2),
('NGN','Nigerian Naira','₦',2),
('GHS','Ghanaian Cedi','₵',2),
('ZAR','South African Rand','R',2),
('ZMW','Zambian Kwacha','ZK',2),
('MWK','Malawian Kwacha','MK',2),
('MZN','Mozambican Metical','MT',2),
('BWP','Botswana Pula','P',2),
('XOF','West African CFA Franc','CFA',0),
('XAF','Central African CFA Franc','FCFA',0),
('EGP','Egyptian Pound','E£',2),
('MAD','Moroccan Dirham','د.م.',2),
('USD','US Dollar','$',2),
('EUR','Euro','€',2),
('GBP','Pound Sterling','£',2),
('CHF','Swiss Franc','CHF',2),
('JPY','Japanese Yen','¥',0),
('CNY','Chinese Yuan','¥',2),
('INR','Indian Rupee','₹',2),
('PKR','Pakistani Rupee','₨',2),
('BDT','Bangladeshi Taka','৳',2),
('LKR','Sri Lankan Rupee','Rs',2),
('PHP','Philippine Peso','₱',2),
('IDR','Indonesian Rupiah','Rp',2),
('MYR','Malaysian Ringgit','RM',2),
('SGD','Singapore Dollar','S$',2),
('THB','Thai Baht','฿',2),
('VND','Vietnamese Dong','₫',0),
('AUD','Australian Dollar','A$',2),
('NZD','New Zealand Dollar','NZ$',2),
('CAD','Canadian Dollar','C$',2),
('BRL','Brazilian Real','R$',2),
('MXN','Mexican Peso','MX$',2),
('ARS','Argentine Peso','$',2),
('COP','Colombian Peso','$',2),
('PEN','Peruvian Sol','S/',2),
('CLP','Chilean Peso','$',0),
('AED','UAE Dirham','د.إ',2),
('SAR','Saudi Riyal','﷼',2),
('QAR','Qatari Riyal','﷼',2),
('TRY','Turkish Lira','₺',2),
('RUB','Russian Ruble','₽',2),
('UAH','Ukrainian Hryvnia','₴',2),
('PLN','Polish Zloty','zł',2),
('SEK','Swedish Krona','kr',2),
('NOK','Norwegian Krone','kr',2),
('DKK','Danish Krone','kr',2),
('CZK','Czech Koruna','Kč',2),
('HUF','Hungarian Forint','Ft',2),
('RON','Romanian Leu','lei',2),
('ILS','Israeli New Shekel','₪',2),
('KRW','South Korean Won','₩',0),
('HKD','Hong Kong Dollar','HK$',2)
ON CONFLICT (code) DO NOTHING;

CREATE OR REPLACE FUNCTION public.set_updated_at_iso_currencies()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_iso_currencies_updated_at ON public.iso_currencies;
CREATE TRIGGER trg_iso_currencies_updated_at
BEFORE UPDATE ON public.iso_currencies
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_iso_currencies();

-- Point onboarding + provisioning currency validation at the global catalog
DO $do$
DECLARE
  r record;
  v_def text;
  v_new text;
BEGIN
  FOR r IN
    SELECT p.oid
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN ('complete_onboarding','provision_company_full')
  LOOP
    v_def := pg_get_functiondef(r.oid);
    v_new := replace(
      v_def,
      'FROM public.currencies WHERE upper(code)',
      'FROM public.iso_currencies WHERE upper(code)'
    );
    v_new := replace(
      v_new,
      'FROM public.currencies WHERE upper(code) = upper(_currency)',
      'FROM public.iso_currencies WHERE upper(code) = upper(_currency)'
    );
    IF v_new <> v_def THEN
      EXECUTE v_new;
    END IF;
  END LOOP;
END
$do$;

-- Ensure a newly created company's base currency exists in its own currency list
CREATE OR REPLACE FUNCTION public.ensure_business_base_currency()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.base_currency IS NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.currencies (organization_id, code, name, symbol, decimal_places, is_active)
  SELECT NEW.organization_id, c.code, c.name, c.symbol, c.decimal_places, true
  FROM public.iso_currencies c
  WHERE c.code = upper(NEW.base_currency)
    AND NOT EXISTS (
      SELECT 1 FROM public.currencies x
      WHERE x.organization_id = NEW.organization_id
        AND upper(x.code) = upper(NEW.base_currency)
    );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_business_base_currency ON public.businesses;
CREATE TRIGGER trg_business_base_currency
AFTER INSERT ON public.businesses
FOR EACH ROW EXECUTE FUNCTION public.ensure_business_base_currency();