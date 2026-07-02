DO $$
DECLARE _result jsonb;
BEGIN
  _result := install_localization_pack_atomic(
    _business_id  => '3ce9b1bd-0083-464e-8a98-63395a778de1',
    _pack_id      => 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    _installed_by => '00000000-0000-0000-0000-000000000000'::uuid,
    _force_reseed => false
  );
  RAISE NOTICE 'INSTALL RESULT: %', _result;
END $$;