-- Phase E: Product Variants foundation (ADR 0072)
-- Option A: variants are first-class product rows joined by variant_parent_id.

-- 1. Axis catalogue (e.g. Size, Colour) scoped per business
CREATE TABLE public.product_variant_axes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL,
  name text NOT NULL,
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, name)
);

-- 2. Allowed values per axis (e.g. S/M/L, Red/Blue)
CREATE TABLE public.product_variant_axis_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  axis_id uuid NOT NULL REFERENCES public.product_variant_axes(id) ON DELETE CASCADE,
  value text NOT NULL,
  display_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (axis_id, value)
);

CREATE INDEX idx_pvav_axis ON public.product_variant_axis_values(axis_id);

-- 3. Variant fields on products
ALTER TABLE public.products
  ADD COLUMN variant_parent_id uuid REFERENCES public.products(id) ON DELETE RESTRICT,
  ADD COLUMN is_variant_parent boolean NOT NULL DEFAULT false,
  ADD COLUMN variant_axis_values jsonb;

CREATE INDEX idx_products_variant_parent
  ON public.products(variant_parent_id)
  WHERE variant_parent_id IS NOT NULL;

-- 4. Invariants
ALTER TABLE public.products
  ADD CONSTRAINT chk_variant_parent_not_self
    CHECK (variant_parent_id IS NULL OR variant_parent_id <> id),
  ADD CONSTRAINT chk_parent_xor_child
    CHECK (NOT (is_variant_parent AND variant_parent_id IS NOT NULL));

-- 5. GRANTs (axes are auth-scoped catalog data; no anon)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_variant_axes TO authenticated;
GRANT ALL ON public.product_variant_axes TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_variant_axis_values TO authenticated;
GRANT ALL ON public.product_variant_axis_values TO service_role;

-- 6. RLS
ALTER TABLE public.product_variant_axes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.product_variant_axis_values ENABLE ROW LEVEL SECURITY;

CREATE POLICY pva_select ON public.product_variant_axes
  FOR SELECT TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

CREATE POLICY pva_insert ON public.product_variant_axes
  FOR INSERT TO authenticated
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id));

CREATE POLICY pva_update ON public.product_variant_axes
  FOR UPDATE TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id))
  WITH CHECK (public.user_can_access_business(auth.uid(), business_id));

CREATE POLICY pva_delete ON public.product_variant_axes
  FOR DELETE TO authenticated
  USING (public.user_can_access_business(auth.uid(), business_id));

CREATE POLICY pvav_select ON public.product_variant_axis_values
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.product_variant_axes a
    WHERE a.id = product_variant_axis_values.axis_id
      AND public.user_can_access_business(auth.uid(), a.business_id)
  ));

CREATE POLICY pvav_insert ON public.product_variant_axis_values
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.product_variant_axes a
    WHERE a.id = product_variant_axis_values.axis_id
      AND public.user_can_access_business(auth.uid(), a.business_id)
  ));

CREATE POLICY pvav_update ON public.product_variant_axis_values
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.product_variant_axes a
    WHERE a.id = product_variant_axis_values.axis_id
      AND public.user_can_access_business(auth.uid(), a.business_id)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.product_variant_axes a
    WHERE a.id = product_variant_axis_values.axis_id
      AND public.user_can_access_business(auth.uid(), a.business_id)
  ));

CREATE POLICY pvav_delete ON public.product_variant_axis_values
  FOR DELETE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.product_variant_axes a
    WHERE a.id = product_variant_axis_values.axis_id
      AND public.user_can_access_business(auth.uid(), a.business_id)
  ));

-- 7. updated_at trigger for axes
CREATE OR REPLACE FUNCTION public.tg_pva_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_pva_updated_at
  BEFORE UPDATE ON public.product_variant_axes
  FOR EACH ROW EXECUTE FUNCTION public.tg_pva_touch_updated_at();
