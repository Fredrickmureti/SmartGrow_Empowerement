-- Clean up the accidentally created vendor owner role
DELETE FROM user_roles WHERE id = '63546cb9-1c4b-4c02-ace7-91758780bf68';

-- Clean up the auto-created business for the accidental org
DELETE FROM businesses WHERE organization_id = '3975c41e-950e-495b-9a90-388e67998089';

-- Clean up accounts for the accidental org
DELETE FROM accounts WHERE organization_id = '3975c41e-950e-495b-9a90-388e67998089';

-- Delete the accidental organization itself
DELETE FROM organizations WHERE id = '3975c41e-950e-495b-9a90-388e67998089';