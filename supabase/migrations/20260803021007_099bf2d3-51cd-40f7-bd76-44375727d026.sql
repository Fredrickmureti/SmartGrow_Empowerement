-- =====================================================================
-- Phase 6a — Branch-gated RLS for the cycle count tables.
-- Mirrors the inventory module standard (business + branch).
-- =====================================================================

DROP POLICY IF EXISTS "wms_count_sessions business scoped select" ON public.wms_count_sessions;
DROP POLICY IF EXISTS "wms_count_sessions business scoped write"  ON public.wms_count_sessions;

CREATE POLICY "wms_count_sessions branch scoped select"
  ON public.wms_count_sessions FOR SELECT TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
  );

CREATE POLICY "wms_count_sessions branch scoped write"
  ON public.wms_count_sessions FOR ALL TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
  )
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND (branch_id IS NULL OR public.can_access_branch(auth.uid(), branch_id))
  );

DROP POLICY IF EXISTS "wms_count_lines business scoped select" ON public.wms_count_lines;
DROP POLICY IF EXISTS "wms_count_lines business scoped write"  ON public.wms_count_lines;

CREATE POLICY "wms_count_lines branch scoped select"
  ON public.wms_count_lines FOR SELECT TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND EXISTS (
      SELECT 1 FROM public.wms_count_sessions s
       WHERE s.id = wms_count_lines.session_id
         AND (s.branch_id IS NULL OR public.can_access_branch(auth.uid(), s.branch_id))
    )
  );

CREATE POLICY "wms_count_lines branch scoped write"
  ON public.wms_count_lines FOR ALL TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND EXISTS (
      SELECT 1 FROM public.wms_count_sessions s
       WHERE s.id = wms_count_lines.session_id
         AND (s.branch_id IS NULL OR public.can_access_branch(auth.uid(), s.branch_id))
    )
  )
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND EXISTS (
      SELECT 1 FROM public.wms_count_sessions s
       WHERE s.id = wms_count_lines.session_id
         AND (s.branch_id IS NULL OR public.can_access_branch(auth.uid(), s.branch_id))
    )
  );

DROP POLICY IF EXISTS "wms_count_triggers read"  ON public.wms_count_triggers;
DROP POLICY IF EXISTS "wms_count_triggers write" ON public.wms_count_triggers;

CREATE POLICY "wms_count_triggers branch scoped read"
  ON public.wms_count_triggers FOR SELECT TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND EXISTS (
      SELECT 1 FROM public.warehouses w
       WHERE w.id = wms_count_triggers.warehouse_id
         AND (w.branch_id IS NULL OR public.can_access_branch(auth.uid(), w.branch_id))
    )
  );

CREATE POLICY "wms_count_triggers branch scoped write"
  ON public.wms_count_triggers FOR ALL TO authenticated
  USING (
    public.user_can_access_business(auth.uid(), business_id)
    AND EXISTS (
      SELECT 1 FROM public.warehouses w
       WHERE w.id = wms_count_triggers.warehouse_id
         AND (w.branch_id IS NULL OR public.can_access_branch(auth.uid(), w.branch_id))
    )
  )
  WITH CHECK (
    public.user_can_access_business(auth.uid(), business_id)
    AND EXISTS (
      SELECT 1 FROM public.warehouses w
       WHERE w.id = wms_count_triggers.warehouse_id
         AND (w.branch_id IS NULL OR public.can_access_branch(auth.uid(), w.branch_id))
    )
  );