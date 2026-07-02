-- Wave B3.1-fix — regression guard for tg_mirror_attendance_device_to_assignment().
--
-- Contract under test:
--   For every (organization_id, attendance_device_id) pair, exactly ONE row
--   exists in public.device_assignments with role='clock_terminal', no matter
--   how many times the underlying attendance_devices row is updated.
--
-- Scenario:
--   1. INSERT a fake attendance_devices row → expect 1 mirror row, enabled.
--   2. UPDATE that row 3 times (different metadata each time) → still 1 row.
--   3. UPDATE status='disabled' → mirror still 1 row, now enabled=false.
--   4. DELETE the device → mirror still 1 row (soft-disabled), enabled=false.
--
-- Run with: supabase test db
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(6);

DO $$
DECLARE
  v_org    uuid := gen_random_uuid();
  v_device uuid;
BEGIN
  -- Seed an organization shell so the FK on device_assignments.organization_id holds.
  INSERT INTO public.organizations (id, name, slug)
    VALUES (v_org, 'B3.1-fix probe org', 'b31fix-' || substr(v_org::text, 1, 8))
    ON CONFLICT (id) DO NOTHING;

  -- (1) INSERT — mirror created.
  INSERT INTO public.attendance_devices
    (organization_id, public_id, serial, vendor, status, hmac_secret)
  VALUES
    (v_org, 'probe-' || substr(gen_random_uuid()::text, 1, 8),
     'SN-PROBE-001', 'zkteco', 'active', E'\\x00')
  RETURNING id INTO v_device;

  PERFORM is(
    (SELECT count(*)::int FROM public.device_assignments
      WHERE organization_id = v_org
        AND role = 'clock_terminal'
        AND (config->>'attendance_device_id') = v_device::text),
    1,
    'INSERT creates exactly one mirror row'
  );

  PERFORM is(
    (SELECT enabled FROM public.device_assignments
      WHERE organization_id = v_org
        AND role = 'clock_terminal'
        AND (config->>'attendance_device_id') = v_device::text),
    true,
    'mirror row is enabled when device is active'
  );

  -- (2) UPDATE three times — count must stay 1.
  FOR i IN 1..3 LOOP
    UPDATE public.attendance_devices
       SET metadata = jsonb_build_object('name', 'probe rev ' || i)
     WHERE id = v_device;
  END LOOP;

  PERFORM is(
    (SELECT count(*)::int FROM public.device_assignments
      WHERE organization_id = v_org
        AND role = 'clock_terminal'
        AND (config->>'attendance_device_id') = v_device::text),
    1,
    'three UPDATEs do not multiply the mirror row'
  );

  -- (3) Disable — still 1 row, now enabled=false.
  UPDATE public.attendance_devices SET status = 'disabled' WHERE id = v_device;

  PERFORM is(
    (SELECT count(*)::int FROM public.device_assignments
      WHERE organization_id = v_org
        AND role = 'clock_terminal'
        AND (config->>'attendance_device_id') = v_device::text),
    1,
    'disabling the device keeps exactly one mirror row'
  );

  PERFORM is(
    (SELECT enabled FROM public.device_assignments
      WHERE organization_id = v_org
        AND role = 'clock_terminal'
        AND (config->>'attendance_device_id') = v_device::text),
    false,
    'mirror row flips to enabled=false on disable'
  );

  -- (4) DELETE — soft-disable path retains the row.
  DELETE FROM public.attendance_devices WHERE id = v_device;

  PERFORM is(
    (SELECT count(*)::int FROM public.device_assignments
      WHERE organization_id = v_org
        AND role = 'clock_terminal'
        AND (config->>'attendance_device_id') = v_device::text),
    1,
    'DELETE soft-disables instead of removing the mirror row'
  );
END
$$;

SELECT * FROM finish();
ROLLBACK;
