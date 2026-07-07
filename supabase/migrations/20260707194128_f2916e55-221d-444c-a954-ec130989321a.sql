
ALTER TABLE public.localization_pack_remittance_schedules
  ADD COLUMN IF NOT EXISTS roll_forward_weekend_holiday BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS grace_days SMALLINT NOT NULL DEFAULT 0
    CHECK (grace_days >= 0 AND grace_days <= 30);

COMMENT ON COLUMN public.localization_pack_remittance_schedules.roll_forward_weekend_holiday IS
  'When true, if the computed due date falls on Sat/Sun or a public holiday in the tenant country, the scheduler rolls the due date forward to the next business day. ADR-0010 Gap #4.';

COMMENT ON COLUMN public.localization_pack_remittance_schedules.grace_days IS
  'Extra calendar days added to the computed due date before penalties apply (authority-published grace window). 0 = no grace.';
