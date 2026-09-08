# Organization Ownership, Administration and Recovery

Authoritative reference for who controls the institution and how that control moves.
Companion to `.lovable/plan.md` (investigation verdict).

## Model

```
Organization
   └── Owner (exactly one, organizations.owner_user_id)
         └── Administrators (employees holding an administrative Access Group)
               └── Access Groups → Employees (branch-scoped)
```

- **Owner** — one per organization, recorded on `organizations.owner_user_id` and mirrored by the
  single active `owner` row in `user_roles`. The two are kept in step by the triggers
  `sync_organization_owner` (on `organizations`) and `protect_organization_owner_role`
  (on `user_roles`). The owner cannot be deleted, deactivated, re-roled or blanked, and a
  replacement owner must already be an active member.
- **Administrator** — a *delegated* capability, expressed only through Access Groups. Today the
  "Institution Admin" group is the one that grants institution-wide `team` write.
  `is_org_administrator(user, org)` is the single resolver; `is_org_admin_or_owner` and
  `is_org_manager` delegate to it.
- **Super Admin** — retired. Zero users hold it, the resolvers ignore it, and the frontend now
  grants it nothing. The enum value survives only until the remaining dead wording in older
  functions and access rules is swept.
- **Branch authority** — a Branch Manager administers their own branches. Institution-wide reach
  comes from the owner record or an institution-wide Access Group, never from a role label.
- **Accountant ≠ Security Administrator.** Posting money and granting permissions live in
  different Access Groups.

## Bootstrap

A new institution is created only through `create_organization_with_owner(...)`, which sets
`owner_user_id`, inserts the owner role row, creates the HQ branch and seeds the seven system
Access Groups. There is no email-based or seeded-id promotion path; `bootstrap_super_admin` was
dropped.

## Ownership transfer

Table `organization_ownership_transfers`, actions `propose_ownership_transfer`,
`accept_ownership_transfer`, `cancel_ownership_transfer`.

- Only the current owner may propose; the recipient must already be an active internal employee.
- One pending handover per organization; it expires after 7 days.
- Only the recipient may accept; either party may cancel.
- On acceptance the outgoing owner keeps membership and is left as an ordinary employee — they do
  not retain blanket authority.
- Every event is written to `audit_logs` as `ownership_transfer_proposed | accepted | cancelled`.
- UI: `src/components/settings/OwnershipCard.tsx`, on `/settings/workspace?tab=workspace`.

## Succession and recovery (last resort)

Ordered, from safest to last resort:

1. **Owner present** — owner proposes a transfer; recipient accepts. Normal path.
2. **Owner leaving, planned** — same as (1), performed before the leaver's account is deactivated.
   Never deactivate the owner first: the protective trigger will refuse it, by design.
3. **Owner unavailable, administrators present** — administrators can continue to run the
   institution (invite, assign Access Groups, change branch assignments, manage settings). They
   cannot appoint a new owner. This is intentional: appointing an owner is an ownership act.
4. **Owner inaccessible and no administrator** — the only remaining route is direct database
   access by an authorised operator, updating `organizations.owner_user_id` to an existing active
   member (the trigger enforces membership). This is deliberately a console-only operation. It
   must be recorded as an incident, and the acting operator must file the corresponding
   `audit_logs` entry describing who authorised the change and why.

There is no email-based self-service recovery and none should be added: an email reset path would
recreate exactly the identity-by-email weakness this work removed.

## What must not change

Access Groups, branch scope, invitations, membership and the existing audit infrastructure are
sound and stay. No second authorization or audit system.
