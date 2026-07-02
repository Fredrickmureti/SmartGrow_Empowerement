-- pgTAP: pack_publisher_grants role matrix + is_pack_publisher helper.
-- Guards the invariant that only 'owner' and 'publisher' grants confer
-- publish authority; 'reviewer' does not. This is the security spine of
-- the localization publishing platform — a regression here would let
-- partner reviewers write to packs they can only comment on.
BEGIN;
SELECT plan(4);

-- Fixtures
INSERT INTO public.organizations (id, name)
VALUES ('55555555-5555-5555-5555-555555555555', 'PgTAP Publisher Org')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.localization_packs (id, country_code, name, publisher_org_id, publisher_kind)
VALUES (
  '66666666-6666-6666-6666-666666666666',
  'ZZ', 'PgTAP Pack',
  '55555555-5555-5555-5555-555555555555',
  'partner'
) ON CONFLICT (id) DO UPDATE SET publisher_org_id = EXCLUDED.publisher_org_id;

-- Owner grant → is_pack_publisher() TRUE
INSERT INTO public.pack_publisher_grants (publisher_org_id, user_id, role)
VALUES ('55555555-5555-5555-5555-555555555555',
        '77777777-7777-7777-7777-777777777777', 'owner')
ON CONFLICT DO NOTHING;

SELECT ok(
  public.is_pack_publisher(
    '77777777-7777-7777-7777-777777777777'::uuid,
    '66666666-6666-6666-6666-666666666666'::uuid),
  'owner grant confers publish authority'
);

-- Publisher grant → TRUE
INSERT INTO public.pack_publisher_grants (publisher_org_id, user_id, role)
VALUES ('55555555-5555-5555-5555-555555555555',
        '88888888-8888-8888-8888-888888888888', 'publisher')
ON CONFLICT DO NOTHING;

SELECT ok(
  public.is_pack_publisher(
    '88888888-8888-8888-8888-888888888888'::uuid,
    '66666666-6666-6666-6666-666666666666'::uuid),
  'publisher grant confers publish authority'
);

-- Reviewer grant → FALSE
INSERT INTO public.pack_publisher_grants (publisher_org_id, user_id, role)
VALUES ('55555555-5555-5555-5555-555555555555',
        '99999999-9999-9999-9999-999999999999', 'reviewer')
ON CONFLICT DO NOTHING;

SELECT ok(
  NOT public.is_pack_publisher(
    '99999999-9999-9999-9999-999999999999'::uuid,
    '66666666-6666-6666-6666-666666666666'::uuid),
  'reviewer grant does NOT confer publish authority'
);

-- Unknown user → FALSE
SELECT ok(
  NOT public.is_pack_publisher(
    '11111111-2222-3333-4444-555555555555'::uuid,
    '66666666-6666-6666-6666-666666666666'::uuid),
  'unrelated user has no publish authority'
);

SELECT * FROM finish();
ROLLBACK;