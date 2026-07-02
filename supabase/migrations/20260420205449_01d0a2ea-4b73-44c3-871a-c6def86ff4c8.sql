-- One-shot cleanup of the stuck test user. Cascades handle dependent rows.
DELETE FROM auth.users WHERE email = 'fredrickmureti612@gmail.com';