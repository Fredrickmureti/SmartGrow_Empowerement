-- Seed default self_action_policy rows (mode='block') for every payroll
-- payment batch lifecycle action key, per organization. Mirrors the
-- payroll.approve seed in 20260611180840: by default, the maker of a
-- payment batch cannot also approve/lock/transmit/pay/cancel/reverse it.
-- Org owners can relax per-key via the Governance UI.
INSERT INTO public.self_action_policy (organization_id, action_key, mode, applies_to_role, notes)
SELECT DISTINCT b.organization_id, k.action_key, 'block', NULL::public.app_role,
       'Seeded default: maker cannot self-' || split_part(k.action_key, '.', 2) || ' a payroll payment batch'
  FROM public.businesses b
  CROSS JOIN (VALUES
    ('payroll_payment_batch.approve'),
    ('payroll_payment_batch.lock'),
    ('payroll_payment_batch.transmit'),
    ('payroll_payment_batch.pay'),
    ('payroll_payment_batch.cancel'),
    ('payroll_payment_batch.reverse')
  ) AS k(action_key)
 WHERE b.organization_id IS NOT NULL
ON CONFLICT DO NOTHING;