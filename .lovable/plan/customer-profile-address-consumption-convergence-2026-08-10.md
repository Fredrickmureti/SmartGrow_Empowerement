# Customer Profile — Address Consumption Convergence

## Evidence-backed findings

**Canonical resolver already exists.** `src/lib/contactAddresses.ts` owns the whole domain: `listPartyAddresses(contactId)` (root row + child rows via `parent_contact_id`, ordered by default-shipping), `pickAddressForRole(addresses, "shipping"|"billing")` (default flag → matching `child_address_type` → party's own row), `resolveShipTo` / `resolveBillTo`, `formatAddress` / `formatAddressInline`, `applyPartyScope`, and the snapshot capture helpers. Defaults are modelled by `is_default_shipping` / `is_default_billing`, kept unique per parent by a DB trigger. So default-address semantics, multiple addresses, and role distinction all exist already.

**Why the address is missing on the profile.** `src/hooks/useContactProfile.ts` loads the contact with a single `contacts.select("*").eq("id", contactId)` — the root row only. `src/pages/contacts/ContactProfile.tsx` (line ~824) then renders `formatAddressInline(contact)` off that root row's own `address_line1/city/country`. Child address rows are never queried, so an address added through the address book is invisible there. This is consumer drift, not corruption, not a party-scope side effect (the profile reads by id, which is exempt from `applyPartyScope`).

**Second defect — party boundary leak in the profile's Hierarchy tab.** `src/hooks/useContactHierarchy.ts` selects the commercial-partner tree and builds `children` as `all.filter(n => n.parent_contact_id === self.id)` with no `child_address_type IS NULL` filter, even though it already selects that column. Address rows therefore appear under "Contacts at this company" as if they were parties — the same class of defect the previous hardening fixed for lists and pickers.

**Consumers that are already correct (leave alone).**
- Sales order / delivery-note ship-to: `src/components/addresses/ShipToPicker.tsx` uses `listPartyAddresses` + `pickAddressForRole`.
- Documents / invoices / statements: `src/services/documents/snapshots/partyAddress.ts` implements snapshot-first, live-party-fallback (`resolveSnapshotAddress`). Posted-document history must stay frozen — no change.
- Bill-to freezing at creation: `captureBillToSnapshot` / `captureRemitToSnapshot` / `freezeBillToSnapshot`.
- Party lists/pickers: scoped via `applyPartyScope`, ratcheted by `src/test/architecture/contact-party-scope.test.ts`.

**Cache boundary.** `ContactAddressBook` invalidates `["party-addresses", contactId]` and `["contacts"]`. The profile uses `["contact-profile", contactId, orgId]` and the hierarchy uses `["contact-hierarchy", ...]`, so neither is refreshed after an address write. Even after the profile reads addresses, it must share the `["party-addresses", contactId]` key so the existing invalidation covers it.

**Tenant isolation / performance.** `listPartyAddresses` filters by `parent_contact_id` under RLS (org/business scoped), so cross-tenant rows cannot resolve. Adding it to the profile is one extra query per profile view, cached by react-query — no N+1.

## Verdicts

| Area | Verdict |
| --- | --- |
| Canonical address ownership | Correct |
| Customer profile consumption | Wrong — reads root row only |
| Address resolution | Correct (resolver exists, unused by profile) |
| Address type handling | Correct in resolver, absent in profile |
| Default/preferred address semantics | Correct (`is_default_shipping` / `is_default_billing`) |
| Cache invalidation | Needs improvement — profile/hierarchy keys not invalidated |
| Sales consumption | Correct |
| Invoice consumption | Correct (snapshot-first) |
| Statement consumption | Correct |
| Document generation | Correct |
| POS consumption | Correct (party-scoped; POS does not print addresses) |
| Vendor symmetry | Same profile defect applies via the shared profile page; vendor documents correct |
| Tenant isolation | Correct |
| Performance | Correct after change (single cached query) |
| Architectural duplication | Correct today — must not add a second resolver |

## Convergence (minimal)

1. **New shared hook** `src/hooks/useContactAddresses.ts` — thin react-query wrapper over `listPartyAddresses`, query key `["party-addresses", contactId]` (the exact key the address book already invalidates). No new SQL, no new formatting.
2. **Profile Overview tab** — replace the single root-row address line with an "Addresses" block rendered from the hook: main address (party row) plus each child address labelled by `child_address_type` (Delivery / Invoice / Contact / Other) with Default billing / Default delivery badges, formatted only through `formatAddressInline` / `formatAddress`. Empty addresses hidden via `isEmptyAddress`.
3. **Hierarchy leak fix** — in `useContactHierarchy`, exclude rows with a non-null `child_address_type` from `children` and `siblings` (client-side filter on the already-selected column; no extra query).
4. **Invalidation lifecycle** — on address save/delete in `ContactAddressBook`, also invalidate `["contact-profile", contactId]` and `["contact-hierarchy"]` so the business event propagates to its projections. No forced reloads.

No schema migration. No change to snapshot behaviour, sales pickers, or document generation.

## Regression tests

Extend `src/test/addresses/address-lifecycle.test.ts` and the architecture ratchets:
- profile hook/page resolves addresses through `listPartyAddresses` (via `useContactAddresses`) — no second resolver, no inline `parent_contact_id` query in the profile;
- child address rows never appear in hierarchy children/siblings;
- delivery vs invoice addresses stay distinguishable and default flags win in `pickAddressForRole`;
- addresses resolve only for the requested parent (no cross-party or cross-tenant bleed);
- address rows stay role-neutral and out of party pickers (existing ratchet kept);
- `resolveSnapshotAddress` still prefers the stored snapshot over live master data;
- address mutation invalidates the profile/hierarchy keys.
