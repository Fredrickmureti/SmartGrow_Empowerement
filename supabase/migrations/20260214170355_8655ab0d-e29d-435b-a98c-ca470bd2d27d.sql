-- Fix Bob's stale Portal User group assignment: move to Internal Users
-- Bob's user_id: 0681e1a1-ea7a-48c9-b7b8-49e5fefe7100
-- Org: a2b62719-2f78-4ceb-b851-edc74f70c324
-- Current wrong group: Portal User (d9287dd6-d5d3-4c40-a8b5-5167a5513627)
-- Correct group: Internal Users (b43d6aec-6647-417d-af75-6697bf1ba9d6)

UPDATE member_permission_groups
SET permission_group_id = 'b43d6aec-6647-417d-af75-6697bf1ba9d6'
WHERE user_id = '0681e1a1-ea7a-48c9-b7b8-49e5fefe7100'
  AND organization_id = 'a2b62719-2f78-4ceb-b851-edc74f70c324'
  AND permission_group_id = 'd9287dd6-d5d3-4c40-a8b5-5167a5513627';