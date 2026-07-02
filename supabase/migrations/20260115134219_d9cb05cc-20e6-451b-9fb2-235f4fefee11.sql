-- Create platform exchange rates table for admin currency settings
CREATE TABLE public.platform_exchange_rates (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  from_currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  to_currency VARCHAR(3) NOT NULL,
  rate DECIMAL(18, 8) NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE(from_currency, to_currency)
);

-- Enable RLS
ALTER TABLE public.platform_exchange_rates ENABLE ROW LEVEL SECURITY;

-- Create policies - platform admins can manage
CREATE POLICY "Platform admins can manage exchange rates"
ON public.platform_exchange_rates
FOR ALL
USING (public.is_platform_admin(auth.uid()))
WITH CHECK (public.is_platform_admin(auth.uid()));

-- Anyone authenticated can read exchange rates
CREATE POLICY "Authenticated users can read exchange rates"
ON public.platform_exchange_rates
FOR SELECT
USING (auth.role() = 'authenticated');

-- Create updated_at trigger
CREATE TRIGGER update_platform_exchange_rates_updated_at
BEFORE UPDATE ON public.platform_exchange_rates
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

-- Insert default USD to KES rate
INSERT INTO public.platform_exchange_rates (from_currency, to_currency, rate)
VALUES ('USD', 'KES', 129.50);