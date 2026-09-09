# Loan application form — derive branch, officer and group from the client

## Status of the previous wave (verified, not taken on trust)

Checked directly against the live database and the code:

- `mf_register_client(p_business_id, p_client, p_group_id)` exists.
- `mf_group_members` carries both guards: `mf_group_members_limit` (one active
  group per client) and `mf_group_members_consistency`.
- `useBranchOfficers` exists and the client registration dialog uses it.

The client KYC wave is complete. Nothing to redo there.

## What the loan application form does today (verified)

In the new-application dialog:

- Client, branch, loan officer and group are four independent pickers.
- Branch lists every branch; loan officer lists every organisation member
  (not people actually assigned to a branch); group lists every group in the
  institution regardless of the client.
- Picking a client already copies the client's branch and officer into the
  form, but they remain free-text choices afterwards and the group is untouched.

## What the backend already enforces (verified)

The application guard refuses, with plain sentences:

- a client from another institution;
- an application booked outside the client's own branch (non-admins);
- a group from another institution;
- "That client is not a member of the selected group".

So the integrity rules are already in the database. This wave is a
presentation fix: stop asking the operator to reconstruct what the system
knows, and stop offering combinations the database will refuse.

## Changes (frontend only)

Relationship block of the loan application dialog:

1. **Client first.** Choosing a client fills in, and shows as derived:
   - Branch — the client's branch, shown read-only with the note
     "Taken from the client's branch."
   - Loan officer — the client's own officer, chosen from staff actually
     assigned to that branch (`useBranchOfficers`), not from all members.
   - Group — the client's single active group, filled in automatically and
     shown as derived; "This client is not in a group." when there is none.
2. **No client chosen yet**: branch, officer and group stay disabled with
   "Select a client first."
3. **Group is no longer a free list.** Since the backend requires the client to
   be a member, the only valid value is the client's active group (or none).
4. Editing an existing application keeps its stored values and re-derives only
   when the client is changed.
5. Refusals continue to surface through the existing lending error helper — no
   new error handling.

## Technical notes

- New small hook `useMfClientActiveGroup(clientId)` reading `mf_group_members`
  joined to `mf_groups` for the active membership; it reuses the existing
  Supabase client and query conventions, and adds no write path.
- Officer options come from the existing `useBranchOfficers`, filtered to the
  client's branch.
- No migration. No change to `_mf_application_guard` — it already covers every
  invalid combination this form could otherwise produce.

## Verification

- Typecheck and build.
- In the app: pick a client with a group (branch, officer and group all fill
  in), a client with no group (group shows the empty sentence), change the
  client (all three re-derive), and save — confirming the application stores
  the derived group. Results reported as observed, including failures.
