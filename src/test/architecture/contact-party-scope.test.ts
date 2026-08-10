/**
 * ADR-0038 / ADR-0080 — a Contact's addresses are not Contacts.
 *
 * Addresses live in `contacts` as child rows (`parent_contact_id` +
 * `child_address_type`). Every surface that lists PARTIES (contacts list,
 * customer/vendor pickers, ledger party selectors) must exclude those child
 * rows, otherwise saving an address looks like it created a new contact —
 * the exact defect this ratchet exists to prevent.
 *
 * The rule is expressed once, in `applyPartyScope()`. This test enforces:
 *   1. every known party-list reader imports and uses it;
 *   2. nobody hand-rolls the predicate at a call site.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

/** Readers that return a list of parties to a user-facing surface. */
const PARTY_LIST_READERS = [
  "src/hooks/useContacts.ts",
  "src/hooks/useContactsPaginated.ts",
  "src/hooks/pos/usePOSCustomers.ts",
  "src/lib/command/providers/customers.ts",
  "src/hooks/useCustomerCredit.ts",
  "src/hooks/useExecutiveStats.ts",
  "src/components/payments/AdvancePaymentDialog.tsx",
  "src/components/payments/RecordVendorAdvanceDialog.tsx",
  "src/components/hr/payroll/LinkRecipientDialog.tsx",
  "src/components/contacts/ParentCompanyCombobox.tsx",
  "src/pages/warehouse/BillingBoard.tsx",
];

describe("contact party scope (ADR-0038 / ADR-0080)", () => {
  it("exposes the rule from a single canonical helper", () => {
    const src = read("src/lib/contactAddresses.ts");
    expect(src).toMatch(/export function applyPartyScope/);
    expect(src).toMatch(/child_address_type/);
  });

  it.each(PARTY_LIST_READERS)("%s scopes its contacts query to parties", (file) => {
    const src = read(file);
    expect(src).toMatch(/import \{[^}]*applyPartyScope[^}]*\} from "@\/lib\/contactAddresses"/);

    // Whitespace-insensitive: every LIST read of `contacts` must be wrapped by
    // the helper, i.e. `applyPartyScope(supabase.from("contacts")`.
    // Writes (insert/update/delete) and single-row lookups by id are exempt —
    // they address a known row, they never populate a party picker.
    const flat = src.replace(/\s+/g, "");
    const unscoped: string[] = [];
    let idx = flat.indexOf('from("contacts")');
    while (idx !== -1) {
      const prefix = flat.slice(0, idx);
      const tail = flat.slice(idx, idx + 300);
      const isListRead =
        !/^from\("contacts"\)\.(insert|update|delete|upsert)\(/.test(tail) &&
        !/\.(single|maybeSingle)\(\)/.test(tail) &&
        !/\.eq\("id",/.test(tail);
      if (isListRead && !/applyPartyScope\(\(?supabase(asany\))?\.$/.test(prefix)) {
        unscoped.push(flat.slice(Math.max(0, idx - 60), idx + 16));
      }
      idx = flat.indexOf('from("contacts")', idx + 1);
    }
    expect(unscoped).toEqual([]);

  });


  it("nobody hand-rolls the predicate outside the helper", () => {
    const offenders = PARTY_LIST_READERS.filter((f) =>
      /\.is\(\s*["']child_address_type["']/.test(read(f)),
    );
    expect(offenders).toEqual([]);
  });
});
