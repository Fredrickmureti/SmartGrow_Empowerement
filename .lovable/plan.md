Exact diagnosis





The KES 1,500 is not an FX difference. Joshua Holdings posted intercompany sales of KES 60 + KES 1,440 through invoices 00001 and 00002.


Mombasa Port Services has no matching intercompany expense/payable posting for that KES 1,500.


The correct resolution is to post the missing Mombasa entry through the source transaction workflow:



Debit: Intercompany management fees expense (5180)


Credit: Intercompany payable — Joshua Holdings (2180)


Using the original transaction currency/rate and supporting document.






Then regenerate eliminations. The trading gap should become zero while the policy remains KES 100 + Refuse the run.





Why KES 1,500 tolerance was blocked




The UI is intentionally preventing tolerance from being fitted to the known error. A tolerance of KES 1,500 would declare the missing invoice immaterial rather than correct it.




KES 100 is not a frontend maximum, but it is based on a database policy formula:



100 × 10^(2 − currency decimal places)




For KES, which has two decimal places, that returns KES 100. So the 100 base is encoded in the database formula, but it is a currency-scaled rounding boundary—not a universal input limit.




Why both policy saves crashed




That is a separate implementation bug:





The audit trigger writes entity = 'elimination_rule'.


consolidation_group_change_log_entity_check does not permit elimination_rule or elimination_rule_pair.


Therefore every relevant policy save fails before completion, regardless of selecting G2900 or the translation reserve.





I prepared the correct constraint repair, but it could not be applied because this is an externally managed Supabase project and the migration connection was unavailable.




About G2900




G2900 · Other liabilities is not an appropriate home for an unexplained trading mismatch. If management explicitly approves carrying a genuine residual, create a dedicated group income/expense account such as “Intercompany elimination differences” in Consolidation Account Mapping, then select it. The existing group-account screen already supports creating such an account.




For this specific KES 1,500, however, do not use G2900, CTA, or increased tolerance—correct Mombasa’s missing source posting.