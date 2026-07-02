-- =============================================
-- Fix RLS Policies for Restaurant Mode Tables
-- =============================================
-- Root Cause: Policies were querying profiles.organization_id which doesn't exist
-- Solution: Use the existing is_org_member() security definer function

-- =============================================
-- 1. pos_floors - Floor Plans
-- =============================================
DROP POLICY IF EXISTS "Users can view floors in their organization" ON public.pos_floors;
DROP POLICY IF EXISTS "Users can manage floors in their organization" ON public.pos_floors;

CREATE POLICY "Users can view floors in their organization"
ON public.pos_floors FOR SELECT
USING (is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can manage floors in their organization"
ON public.pos_floors FOR ALL
USING (is_org_member(auth.uid(), organization_id));

-- =============================================
-- 2. pos_tables - Table Layout
-- =============================================
DROP POLICY IF EXISTS "Users can view tables in their organization" ON public.pos_tables;
DROP POLICY IF EXISTS "Users can manage tables in their organization" ON public.pos_tables;

CREATE POLICY "Users can view tables in their organization"
ON public.pos_tables FOR SELECT
USING (is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can manage tables in their organization"
ON public.pos_tables FOR ALL
USING (is_org_member(auth.uid(), organization_id));

-- =============================================
-- 3. pos_table_sessions - Active Table Orders
-- =============================================
DROP POLICY IF EXISTS "Users can view table sessions in their organization" ON public.pos_table_sessions;
DROP POLICY IF EXISTS "Users can manage table sessions in their organization" ON public.pos_table_sessions;

CREATE POLICY "Users can view table sessions in their organization"
ON public.pos_table_sessions FOR SELECT
USING (is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can manage table sessions in their organization"
ON public.pos_table_sessions FOR ALL
USING (is_org_member(auth.uid(), organization_id));

-- =============================================
-- 4. pos_courses - Course Management (Starter, Main, Dessert)
-- =============================================
DROP POLICY IF EXISTS "Users can view courses in their organization" ON public.pos_courses;
DROP POLICY IF EXISTS "Users can manage courses in their organization" ON public.pos_courses;

CREATE POLICY "Users can view courses in their organization"
ON public.pos_courses FOR SELECT
USING (is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can manage courses in their organization"
ON public.pos_courses FOR ALL
USING (is_org_member(auth.uid(), organization_id));

-- =============================================
-- 5. pos_kitchen_orders - Kitchen Display System
-- =============================================
DROP POLICY IF EXISTS "Users can view kitchen orders in their organization" ON public.pos_kitchen_orders;
DROP POLICY IF EXISTS "Users can manage kitchen orders in their organization" ON public.pos_kitchen_orders;

CREATE POLICY "Users can view kitchen orders in their organization"
ON public.pos_kitchen_orders FOR SELECT
USING (is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can manage kitchen orders in their organization"
ON public.pos_kitchen_orders FOR ALL
USING (is_org_member(auth.uid(), organization_id));

-- =============================================
-- 6. pos_table_bookings - Reservations
-- =============================================
DROP POLICY IF EXISTS "Users can view bookings in their organization" ON public.pos_table_bookings;
DROP POLICY IF EXISTS "Users can manage bookings in their organization" ON public.pos_table_bookings;

CREATE POLICY "Users can view bookings in their organization"
ON public.pos_table_bookings FOR SELECT
USING (is_org_member(auth.uid(), organization_id));

CREATE POLICY "Users can manage bookings in their organization"
ON public.pos_table_bookings FOR ALL
USING (is_org_member(auth.uid(), organization_id));