-- ============================================
-- PIN-Based Quick Login & Device Tracking Security
-- ============================================

-- 1. USER PINS TABLE
-- Stores PIN hashes for device-bound quick login
CREATE TABLE public.user_pins (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_fingerprint TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  pin_length INTEGER NOT NULL DEFAULT 4 CHECK (pin_length >= 4 AND pin_length <= 6),
  is_active BOOLEAN NOT NULL DEFAULT true,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, device_fingerprint)
);

-- 2. USER DEVICES TABLE
-- Tracks all devices a user has logged in from
CREATE TABLE public.user_devices (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_fingerprint TEXT NOT NULL,
  device_name TEXT,
  browser TEXT,
  browser_version TEXT,
  os TEXT,
  os_version TEXT,
  device_type TEXT CHECK (device_type IN ('desktop', 'mobile', 'tablet', 'unknown')),
  ip_address INET,
  city TEXT,
  region TEXT,
  country TEXT,
  country_code TEXT,
  latitude DECIMAL(9,6),
  longitude DECIMAL(9,6),
  is_trusted BOOLEAN NOT NULL DEFAULT false,
  trust_expires_at TIMESTAMPTZ,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_count INTEGER NOT NULL DEFAULT 1,
  is_current BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, device_fingerprint)
);

-- 3. LOGIN HISTORY TABLE
-- Comprehensive log of all login attempts
CREATE TABLE public.login_history (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  device_id UUID REFERENCES public.user_devices(id) ON DELETE SET NULL,
  email TEXT,
  device_fingerprint TEXT,
  ip_address INET,
  city TEXT,
  region TEXT,
  country TEXT,
  country_code TEXT,
  login_method TEXT NOT NULL CHECK (login_method IN ('password', 'pin', 'magic_link', 'oauth', 'sso')),
  status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'blocked', 'locked_out')),
  failure_reason TEXT,
  user_agent TEXT,
  is_new_device BOOLEAN NOT NULL DEFAULT false,
  is_new_location BOOLEAN NOT NULL DEFAULT false,
  alert_sent BOOLEAN NOT NULL DEFAULT false,
  alert_sent_at TIMESTAMPTZ,
  risk_score INTEGER CHECK (risk_score >= 0 AND risk_score <= 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. SECURITY ALERTS TABLE
-- Track security notifications sent to users
CREATE TABLE public.security_alerts (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  login_history_id UUID REFERENCES public.login_history(id) ON DELETE SET NULL,
  device_id UUID REFERENCES public.user_devices(id) ON DELETE SET NULL,
  alert_type TEXT NOT NULL CHECK (alert_type IN ('new_device', 'new_location', 'suspicious_activity', 'lockout', 'pin_reset', 'password_change')),
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  action_url TEXT,
  action_token TEXT,
  action_expires_at TIMESTAMPTZ,
  is_read BOOLEAN NOT NULL DEFAULT false,
  read_at TIMESTAMPTZ,
  is_resolved BOOLEAN NOT NULL DEFAULT false,
  resolved_at TIMESTAMPTZ,
  resolved_action TEXT,
  email_sent BOOLEAN NOT NULL DEFAULT false,
  email_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================
-- INDEXES
-- ============================================

CREATE INDEX idx_user_pins_user_id ON public.user_pins(user_id);
CREATE INDEX idx_user_pins_device_fingerprint ON public.user_pins(device_fingerprint);
CREATE INDEX idx_user_pins_active ON public.user_pins(user_id, is_active) WHERE is_active = true;

CREATE INDEX idx_user_devices_user_id ON public.user_devices(user_id);
CREATE INDEX idx_user_devices_fingerprint ON public.user_devices(device_fingerprint);
CREATE INDEX idx_user_devices_last_seen ON public.user_devices(last_seen_at DESC);

CREATE INDEX idx_login_history_user_id ON public.login_history(user_id);
CREATE INDEX idx_login_history_device_id ON public.login_history(device_id);
CREATE INDEX idx_login_history_created_at ON public.login_history(created_at DESC);
CREATE INDEX idx_login_history_status ON public.login_history(status);
CREATE INDEX idx_login_history_ip ON public.login_history(ip_address);

CREATE INDEX idx_security_alerts_user_id ON public.security_alerts(user_id);
CREATE INDEX idx_security_alerts_unread ON public.security_alerts(user_id, is_read) WHERE is_read = false;
CREATE INDEX idx_security_alerts_created_at ON public.security_alerts(created_at DESC);

-- ============================================
-- RLS POLICIES
-- ============================================

ALTER TABLE public.user_pins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.login_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.security_alerts ENABLE ROW LEVEL SECURITY;

-- User Pins: Users can only manage their own PINs
CREATE POLICY "Users can view own pins" ON public.user_pins
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own pins" ON public.user_pins
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own pins" ON public.user_pins
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own pins" ON public.user_pins
  FOR DELETE USING (auth.uid() = user_id);

-- User Devices: Users can only see their own devices
CREATE POLICY "Users can view own devices" ON public.user_devices
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can update own devices" ON public.user_devices
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own devices" ON public.user_devices
  FOR DELETE USING (auth.uid() = user_id);

-- Service role can insert devices (for edge functions)
CREATE POLICY "Service role can insert devices" ON public.user_devices
  FOR INSERT WITH CHECK (true);

-- Login History: Users can view their own history
CREATE POLICY "Users can view own login history" ON public.login_history
  FOR SELECT USING (auth.uid() = user_id);

-- Service role can insert login history
CREATE POLICY "Service role can insert login history" ON public.login_history
  FOR INSERT WITH CHECK (true);

-- Security Alerts: Users can view and update their own alerts
CREATE POLICY "Users can view own alerts" ON public.security_alerts
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can update own alerts" ON public.security_alerts
  FOR UPDATE USING (auth.uid() = user_id);

-- Service role can insert alerts
CREATE POLICY "Service role can insert alerts" ON public.security_alerts
  FOR INSERT WITH CHECK (true);

-- ============================================
-- RPC FUNCTIONS
-- ============================================

-- Function to set/update user PIN (server-side hashing)
CREATE OR REPLACE FUNCTION public.set_user_pin(
  p_device_fingerprint TEXT,
  p_pin TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_pin_hash TEXT;
  v_result JSONB;
BEGIN
  -- Get current user
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;
  
  -- Validate PIN length
  IF length(p_pin) < 4 OR length(p_pin) > 6 THEN
    RETURN jsonb_build_object('success', false, 'error', 'PIN must be 4-6 digits');
  END IF;
  
  -- Validate PIN is numeric
  IF p_pin !~ '^[0-9]+$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'PIN must contain only numbers');
  END IF;
  
  -- Check for weak PINs (sequential or repeated)
  IF p_pin ~ '^(.)\1+$' THEN
    RETURN jsonb_build_object('success', false, 'error', 'PIN cannot be all the same digit');
  END IF;
  
  IF p_pin IN ('1234', '12345', '123456', '0000', '00000', '000000', '1111', '11111', '111111') THEN
    RETURN jsonb_build_object('success', false, 'error', 'PIN is too common, please choose a stronger one');
  END IF;
  
  -- Hash the PIN using pgcrypto
  v_pin_hash := crypt(p_pin, gen_salt('bf', 10));
  
  -- Insert or update
  INSERT INTO public.user_pins (user_id, device_fingerprint, pin_hash, pin_length)
  VALUES (v_user_id, p_device_fingerprint, v_pin_hash, length(p_pin))
  ON CONFLICT (user_id, device_fingerprint)
  DO UPDATE SET
    pin_hash = v_pin_hash,
    pin_length = length(p_pin),
    is_active = true,
    failed_attempts = 0,
    locked_until = NULL,
    updated_at = now();
  
  RETURN jsonb_build_object('success', true, 'message', 'PIN set successfully');
END;
$$;

-- Function to verify user PIN
CREATE OR REPLACE FUNCTION public.verify_user_pin(
  p_device_fingerprint TEXT,
  p_pin TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_pin_record RECORD;
  v_is_valid BOOLEAN;
  v_max_attempts INTEGER := 5;
  v_lockout_minutes INTEGER := 15;
BEGIN
  -- Get current user
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated', 'locked', false);
  END IF;
  
  -- Get PIN record
  SELECT * INTO v_pin_record
  FROM public.user_pins
  WHERE user_id = v_user_id
    AND device_fingerprint = p_device_fingerprint
    AND is_active = true;
  
  IF v_pin_record IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'No PIN set for this device', 'locked', false);
  END IF;
  
  -- Check if locked out
  IF v_pin_record.locked_until IS NOT NULL AND v_pin_record.locked_until > now() THEN
    RETURN jsonb_build_object(
      'success', false, 
      'error', 'Account temporarily locked. Try again later.',
      'locked', true,
      'locked_until', v_pin_record.locked_until
    );
  END IF;
  
  -- Verify PIN
  v_is_valid := v_pin_record.pin_hash = crypt(p_pin, v_pin_record.pin_hash);
  
  IF v_is_valid THEN
    -- Reset failed attempts and update last used
    UPDATE public.user_pins
    SET failed_attempts = 0, locked_until = NULL, last_used_at = now()
    WHERE id = v_pin_record.id;
    
    RETURN jsonb_build_object('success', true, 'message', 'PIN verified', 'locked', false);
  ELSE
    -- Increment failed attempts
    UPDATE public.user_pins
    SET 
      failed_attempts = failed_attempts + 1,
      locked_until = CASE 
        WHEN failed_attempts + 1 >= v_max_attempts 
        THEN now() + (v_lockout_minutes || ' minutes')::interval
        ELSE NULL
      END
    WHERE id = v_pin_record.id;
    
    IF v_pin_record.failed_attempts + 1 >= v_max_attempts THEN
      RETURN jsonb_build_object(
        'success', false, 
        'error', 'Too many failed attempts. Account locked for ' || v_lockout_minutes || ' minutes.',
        'locked', true,
        'attempts_remaining', 0
      );
    ELSE
      RETURN jsonb_build_object(
        'success', false, 
        'error', 'Invalid PIN',
        'locked', false,
        'attempts_remaining', v_max_attempts - (v_pin_record.failed_attempts + 1)
      );
    END IF;
  END IF;
END;
$$;

-- Function to reset/delete user PIN
CREATE OR REPLACE FUNCTION public.reset_user_pin(
  p_device_fingerprint TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;
  
  DELETE FROM public.user_pins
  WHERE user_id = v_user_id
    AND device_fingerprint = p_device_fingerprint;
  
  RETURN jsonb_build_object('success', true, 'message', 'PIN removed successfully');
END;
$$;

-- Function to check if user has PIN for device
CREATE OR REPLACE FUNCTION public.has_user_pin(
  p_device_fingerprint TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_exists BOOLEAN;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN false;
  END IF;
  
  SELECT EXISTS(
    SELECT 1 FROM public.user_pins
    WHERE user_id = v_user_id
      AND device_fingerprint = p_device_fingerprint
      AND is_active = true
      AND (locked_until IS NULL OR locked_until <= now())
  ) INTO v_exists;
  
  RETURN v_exists;
END;
$$;

-- Function to record device and login
CREATE OR REPLACE FUNCTION public.record_device_login(
  p_device_fingerprint TEXT,
  p_device_name TEXT DEFAULT NULL,
  p_browser TEXT DEFAULT NULL,
  p_browser_version TEXT DEFAULT NULL,
  p_os TEXT DEFAULT NULL,
  p_os_version TEXT DEFAULT NULL,
  p_device_type TEXT DEFAULT 'unknown',
  p_ip_address TEXT DEFAULT NULL,
  p_city TEXT DEFAULT NULL,
  p_region TEXT DEFAULT NULL,
  p_country TEXT DEFAULT NULL,
  p_country_code TEXT DEFAULT NULL,
  p_latitude DECIMAL DEFAULT NULL,
  p_longitude DECIMAL DEFAULT NULL,
  p_login_method TEXT DEFAULT 'password',
  p_user_agent TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID;
  v_user_email TEXT;
  v_device RECORD;
  v_is_new_device BOOLEAN := false;
  v_is_new_location BOOLEAN := false;
  v_device_id UUID;
  v_login_id UUID;
  v_risk_score INTEGER := 0;
BEGIN
  -- Get current user
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'Not authenticated');
  END IF;
  
  -- Get user email
  SELECT email INTO v_user_email FROM auth.users WHERE id = v_user_id;
  
  -- Check if device exists
  SELECT * INTO v_device
  FROM public.user_devices
  WHERE user_id = v_user_id AND device_fingerprint = p_device_fingerprint;
  
  IF v_device IS NULL THEN
    -- New device
    v_is_new_device := true;
    v_risk_score := v_risk_score + 30;
    
    INSERT INTO public.user_devices (
      user_id, device_fingerprint, device_name, browser, browser_version,
      os, os_version, device_type, ip_address, city, region, country,
      country_code, latitude, longitude, is_current
    ) VALUES (
      v_user_id, p_device_fingerprint, p_device_name, p_browser, p_browser_version,
      p_os, p_os_version, p_device_type, p_ip_address::inet, p_city, p_region, p_country,
      p_country_code, p_latitude, p_longitude, true
    )
    RETURNING id INTO v_device_id;
  ELSE
    v_device_id := v_device.id;
    
    -- Check for new location
    IF v_device.country IS DISTINCT FROM p_country THEN
      v_is_new_location := true;
      v_risk_score := v_risk_score + 40;
    ELSIF v_device.city IS DISTINCT FROM p_city THEN
      v_is_new_location := true;
      v_risk_score := v_risk_score + 20;
    END IF;
    
    -- Update device info
    UPDATE public.user_devices
    SET
      device_name = COALESCE(p_device_name, device_name),
      browser = COALESCE(p_browser, browser),
      browser_version = COALESCE(p_browser_version, browser_version),
      os = COALESCE(p_os, os),
      os_version = COALESCE(p_os_version, os_version),
      ip_address = COALESCE(p_ip_address::inet, ip_address),
      city = COALESCE(p_city, city),
      region = COALESCE(p_region, region),
      country = COALESCE(p_country, country),
      country_code = COALESCE(p_country_code, country_code),
      latitude = COALESCE(p_latitude, latitude),
      longitude = COALESCE(p_longitude, longitude),
      last_seen_at = now(),
      session_count = session_count + 1,
      is_current = true,
      updated_at = now()
    WHERE id = v_device_id;
  END IF;
  
  -- Mark other devices as not current
  UPDATE public.user_devices
  SET is_current = false
  WHERE user_id = v_user_id AND id != v_device_id;
  
  -- Record login history
  INSERT INTO public.login_history (
    user_id, device_id, email, device_fingerprint, ip_address,
    city, region, country, country_code, login_method, status,
    user_agent, is_new_device, is_new_location, risk_score
  ) VALUES (
    v_user_id, v_device_id, v_user_email, p_device_fingerprint, p_ip_address::inet,
    p_city, p_region, p_country, p_country_code, p_login_method, 'success',
    p_user_agent, v_is_new_device, v_is_new_location, v_risk_score
  )
  RETURNING id INTO v_login_id;
  
  RETURN jsonb_build_object(
    'success', true,
    'device_id', v_device_id,
    'login_id', v_login_id,
    'is_new_device', v_is_new_device,
    'is_new_location', v_is_new_location,
    'risk_score', v_risk_score,
    'should_alert', v_is_new_device OR v_is_new_location
  );
END;
$$;

-- Function to mark security alert as read
CREATE OR REPLACE FUNCTION public.mark_alert_read(p_alert_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.security_alerts
  SET is_read = true, read_at = now()
  WHERE id = p_alert_id AND user_id = auth.uid();
  
  RETURN FOUND;
END;
$$;

-- Function to trust a device
CREATE OR REPLACE FUNCTION public.trust_device(
  p_device_id UUID,
  p_trust_days INTEGER DEFAULT 30
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.user_devices
  SET 
    is_trusted = true,
    trust_expires_at = now() + (p_trust_days || ' days')::interval,
    updated_at = now()
  WHERE id = p_device_id AND user_id = auth.uid();
  
  RETURN FOUND;
END;
$$;

-- Function to remove/logout device
CREATE OR REPLACE FUNCTION public.remove_device(p_device_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Remove associated PIN
  DELETE FROM public.user_pins
  WHERE user_id = auth.uid()
    AND device_fingerprint = (
      SELECT device_fingerprint FROM public.user_devices WHERE id = p_device_id
    );
  
  -- Remove device
  DELETE FROM public.user_devices
  WHERE id = p_device_id AND user_id = auth.uid();
  
  RETURN FOUND;
END;
$$;

-- Grant execute permissions
GRANT EXECUTE ON FUNCTION public.set_user_pin TO authenticated;
GRANT EXECUTE ON FUNCTION public.verify_user_pin TO authenticated;
GRANT EXECUTE ON FUNCTION public.reset_user_pin TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_user_pin TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_device_login TO authenticated;
GRANT EXECUTE ON FUNCTION public.mark_alert_read TO authenticated;
GRANT EXECUTE ON FUNCTION public.trust_device TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_device TO authenticated;