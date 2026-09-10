
Manual journal entry creation now works. Here's where things stand.

What was wrong (both confirmed, not guessed):

The accounting engine has two versions of its internal write step, and the manual journal entry didn't say which one to use — so the database refused the call outright, before any entry was created. That refusal is a technical error, not a business rule, which is why you saw the vague "an unexpected error occurred" message instead of something useful.
Behind that sat a second fault: the entry was being sent without a currency, which the ledger requires, so it would still have failed at the last step.
What I changed: the manual journal entry routine now names the current, currency-aware accounting engine explicitly and records the entry in your company's own currency at rate 1. If a company has no currency set, the user now gets a plain message telling them to set it in company settings. No tables, data or accounting rules were touched, and the entry still goes through the one authoritative posting path.

Verified with throwaway entries that were all discarded afterwards: a balanced entry saved correctly (numbered JE-00007, posted, two lines, correct branch, KES); an unbalanced entry was refused with a clear reason and left nothing behind; an entry using an account outside the company was refused. No production records were modified, and nothing test-related remains in the ledger.

Not finished: a closed-period entry (5 September) was accepted rather than blocked — that looks like a real gap in the period lock for manual entries and needs its own investigation. Also untested: the permission checks for who may create entries, and the browser walk-through of the form itself (balance totals, error wording, finding the entry afterwards). Credits ran out mid-way, so continuing those needs available credits.