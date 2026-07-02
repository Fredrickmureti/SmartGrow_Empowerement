-- Zero out all opening_balance values to prevent double-counting with journal entries
UPDATE public.accounts SET opening_balance = 0 WHERE opening_balance != 0;