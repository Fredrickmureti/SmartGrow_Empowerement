-- =============================================================================
-- POS Restaurant Mode - Phase 1 Database Schema
-- =============================================================================

-- Floor management for restaurant mode
CREATE TABLE public.pos_floors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  register_id UUID REFERENCES public.pos_registers(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  background_color TEXT DEFAULT '#f3f4f6',
  background_image_url TEXT,
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Tables on floors
CREATE TABLE public.pos_tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  floor_id UUID NOT NULL REFERENCES public.pos_floors(id) ON DELETE CASCADE,
  table_number TEXT NOT NULL,
  seats INTEGER DEFAULT 4,
  shape TEXT DEFAULT 'square' CHECK (shape IN ('square', 'round', 'rectangle')),
  width INTEGER DEFAULT 100,
  height INTEGER DEFAULT 100,
  position_x INTEGER DEFAULT 0,
  position_y INTEGER DEFAULT 0,
  color TEXT DEFAULT '#ffffff',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Table sessions (occupancy tracking)
CREATE TABLE public.pos_table_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  table_id UUID NOT NULL REFERENCES public.pos_tables(id) ON DELETE CASCADE,
  shift_id UUID REFERENCES public.pos_shifts(id) ON DELETE SET NULL,
  status TEXT DEFAULT 'occupied' CHECK (status IN ('available', 'occupied', 'reserved', 'pending_payment')),
  guests_count INTEGER,
  server_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  opened_at TIMESTAMPTZ DEFAULT now(),
  closed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Add table_session_id to pos_transactions for linking orders to tables
ALTER TABLE public.pos_transactions 
ADD COLUMN IF NOT EXISTS table_session_id UUID REFERENCES public.pos_table_sessions(id) ON DELETE SET NULL;

-- Course management for multi-course dining
CREATE TABLE public.pos_courses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  transaction_id UUID NOT NULL REFERENCES public.pos_transactions(id) ON DELETE CASCADE,
  course_number INTEGER NOT NULL,
  name TEXT DEFAULT 'Course',
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'fired', 'in_progress', 'ready', 'served')),
  fired_at TIMESTAMPTZ,
  ready_at TIMESTAMPTZ,
  served_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Kitchen display orders
CREATE TABLE public.pos_kitchen_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  transaction_id UUID NOT NULL REFERENCES public.pos_transactions(id) ON DELETE CASCADE,
  transaction_item_id UUID REFERENCES public.pos_transaction_items(id) ON DELETE CASCADE,
  course_id UUID REFERENCES public.pos_courses(id) ON DELETE SET NULL,
  printer_category TEXT NOT NULL DEFAULT 'kitchen' CHECK (printer_category IN ('kitchen', 'bar', 'dessert', 'grill')),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'ready', 'served', 'cancelled')),
  priority INTEGER DEFAULT 0,
  notes TEXT,
  table_number TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

-- Table bookings/reservations
CREATE TABLE public.pos_table_bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  table_id UUID NOT NULL REFERENCES public.pos_tables(id) ON DELETE CASCADE,
  customer_name TEXT NOT NULL,
  customer_phone TEXT,
  customer_email TEXT,
  party_size INTEGER NOT NULL,
  booking_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  status TEXT DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'checked_in', 'seated', 'completed', 'no_show', 'cancelled')),
  notes TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Add restaurant mode settings to pos_settings
ALTER TABLE public.pos_settings
ADD COLUMN IF NOT EXISTS enable_restaurant_mode BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS enable_table_bookings BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS enable_kitchen_display BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS enable_courses BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS default_floor_id UUID REFERENCES public.pos_floors(id) ON DELETE SET NULL,
ADD COLUMN IF NOT EXISTS table_assignment_required BOOLEAN DEFAULT false;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_pos_floors_org ON public.pos_floors(organization_id);
CREATE INDEX IF NOT EXISTS idx_pos_tables_floor ON public.pos_tables(floor_id);
CREATE INDEX IF NOT EXISTS idx_pos_tables_org ON public.pos_tables(organization_id);
CREATE INDEX IF NOT EXISTS idx_pos_table_sessions_table ON public.pos_table_sessions(table_id);
CREATE INDEX IF NOT EXISTS idx_pos_table_sessions_status ON public.pos_table_sessions(status);
CREATE INDEX IF NOT EXISTS idx_pos_courses_transaction ON public.pos_courses(transaction_id);
CREATE INDEX IF NOT EXISTS idx_pos_kitchen_orders_status ON public.pos_kitchen_orders(status);
CREATE INDEX IF NOT EXISTS idx_pos_kitchen_orders_transaction ON public.pos_kitchen_orders(transaction_id);
CREATE INDEX IF NOT EXISTS idx_pos_table_bookings_date ON public.pos_table_bookings(booking_date);
CREATE INDEX IF NOT EXISTS idx_pos_table_bookings_table ON public.pos_table_bookings(table_id);

-- Enable RLS on all new tables
ALTER TABLE public.pos_floors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_table_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_kitchen_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pos_table_bookings ENABLE ROW LEVEL SECURITY;

-- RLS Policies for pos_floors
CREATE POLICY "Users can view floors in their organization"
ON public.pos_floors FOR SELECT
USING (organization_id IN (
  SELECT organization_id FROM public.profiles WHERE id = auth.uid()
));

CREATE POLICY "Users can manage floors in their organization"
ON public.pos_floors FOR ALL
USING (organization_id IN (
  SELECT organization_id FROM public.profiles WHERE id = auth.uid()
));

-- RLS Policies for pos_tables
CREATE POLICY "Users can view tables in their organization"
ON public.pos_tables FOR SELECT
USING (organization_id IN (
  SELECT organization_id FROM public.profiles WHERE id = auth.uid()
));

CREATE POLICY "Users can manage tables in their organization"
ON public.pos_tables FOR ALL
USING (organization_id IN (
  SELECT organization_id FROM public.profiles WHERE id = auth.uid()
));

-- RLS Policies for pos_table_sessions
CREATE POLICY "Users can view table sessions in their organization"
ON public.pos_table_sessions FOR SELECT
USING (organization_id IN (
  SELECT organization_id FROM public.profiles WHERE id = auth.uid()
));

CREATE POLICY "Users can manage table sessions in their organization"
ON public.pos_table_sessions FOR ALL
USING (organization_id IN (
  SELECT organization_id FROM public.profiles WHERE id = auth.uid()
));

-- RLS Policies for pos_courses
CREATE POLICY "Users can view courses in their organization"
ON public.pos_courses FOR SELECT
USING (organization_id IN (
  SELECT organization_id FROM public.profiles WHERE id = auth.uid()
));

CREATE POLICY "Users can manage courses in their organization"
ON public.pos_courses FOR ALL
USING (organization_id IN (
  SELECT organization_id FROM public.profiles WHERE id = auth.uid()
));

-- RLS Policies for pos_kitchen_orders
CREATE POLICY "Users can view kitchen orders in their organization"
ON public.pos_kitchen_orders FOR SELECT
USING (organization_id IN (
  SELECT organization_id FROM public.profiles WHERE id = auth.uid()
));

CREATE POLICY "Users can manage kitchen orders in their organization"
ON public.pos_kitchen_orders FOR ALL
USING (organization_id IN (
  SELECT organization_id FROM public.profiles WHERE id = auth.uid()
));

-- RLS Policies for pos_table_bookings
CREATE POLICY "Users can view bookings in their organization"
ON public.pos_table_bookings FOR SELECT
USING (organization_id IN (
  SELECT organization_id FROM public.profiles WHERE id = auth.uid()
));

CREATE POLICY "Users can manage bookings in their organization"
ON public.pos_table_bookings FOR ALL
USING (organization_id IN (
  SELECT organization_id FROM public.profiles WHERE id = auth.uid()
));

-- Enable realtime for kitchen display
ALTER PUBLICATION supabase_realtime ADD TABLE public.pos_kitchen_orders;
ALTER PUBLICATION supabase_realtime ADD TABLE public.pos_table_sessions;