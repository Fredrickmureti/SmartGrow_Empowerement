ALTER TABLE public.consolidation_group_change_log
  DROP CONSTRAINT consolidation_group_change_log_entity_check;

ALTER TABLE public.consolidation_group_change_log
  ADD CONSTRAINT consolidation_group_change_log_entity_check
  CHECK (entity = ANY (ARRAY[
    'group','member','group_account','mapping','intercompany_partner',
    'elimination_rule','elimination_rule_pair'
  ]));

-- Each entity kind carries the identifiers that make its audit row readable on
-- its own: a member change names the member, a mapping or partner change names
-- the company whose books it affects, and a group-wide change names neither.
ALTER TABLE public.consolidation_group_change_log
  ADD CONSTRAINT consolidation_group_change_log_shape_check
  CHECK (
    CASE entity
      WHEN 'member' THEN member_id IS NOT NULL
      WHEN 'mapping' THEN business_id IS NOT NULL
      WHEN 'intercompany_partner' THEN business_id IS NOT NULL
      ELSE member_id IS NULL AND business_id IS NULL
    END
  );