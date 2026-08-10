/**
 * ADR-0038 / ADR-0080 — the Contact profile is a DOWNSTREAM CONSUMER of the
 * canonical address domain, not a second address system.
 *
 * The defect this ratchet prevents: the 360° profile read only the root
 * `contacts` row, so an address added through the address book (a child row
 * carrying `child_address_type`) was persisted, visible in the address book,
 * and invisible on the profile. The fix is consumption of the one resolver —
 * NOT a new query, a new formatter, or a new address column.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../../..");
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

const HOOK = "src/hooks/useContactAddresses.ts";
const SECTION = "src/components/contacts/ContactAddressesSection.tsx";
const PROFILE = "src/pages/contacts/ContactProfile.tsx";
const HIERARCHY = "src/hooks/useContactHierarchy.ts";
const ADDRESS_BOOK = "src/features/contacts/ContactAddressBook.tsx";

describe("contact profile address consumption (ADR-0038 / ADR-0080)", () => {
  it("reads addresses through the canonical resolver, not its own query", () => {
    const hook = read(HOOK);
    expect(hook).toMatch(/listPartyAddresses/);
    expect(hook).toMatch(/queryKey: \["party-addresses", contactId\]/);
    // No second resolver: the hook must not touch the table itself.
    expect(hook).not.toMatch(/from\("contacts"\)/);
    expect(hook).not.toMatch(/parent_contact_id/);
  });

  it("renders the profile address block from that hook only", () => {
    const section = read(SECTION);
    expect(section).toMatch(/useContactAddresses/);
    expect(section).not.toMatch(/from\("contacts"\)/);
    expect(section).not.toMatch(/supabase/);
    // Formatting stays in the canonical layer.
    expect(section).toMatch(/formatAddressInline/);
  });

  it("distinguishes address roles and default flags on the profile", () => {
    const section = read(SECTION);
    for (const role of ["delivery", "invoice", "contact", "other"]) {
      expect(section).toContain(role);
    }
    expect(section).toMatch(/is_default_billing/);
    expect(section).toMatch(/is_default_shipping/);
  });

  it("stops the profile from printing only the root row's address", () => {
    const profile = read(PROFILE);
    expect(profile).toMatch(/<ContactAddressesSection contactId=\{contactId\}/);
    expect(profile).not.toMatch(/formatAddressInline\(contact\)/);
  });

  it("keeps address rows out of the hierarchy tree", () => {
    const src = read(HIERARCHY);
    expect(src).toMatch(/child_address_type\s*==\s*null/);
  });

  it("propagates an address write to the profile and hierarchy projections", () => {
    const src = read(ADDRESS_BOOK);
    expect(src).toMatch(/queryKey: \["contact-profile", contactId\]/);
    expect(src).toMatch(/queryKey: \["contact-hierarchy"\]/);
  });

  it("introduces no competing address resolver", () => {
    for (const file of [HOOK, SECTION]) {
      const src = read(file);
      // Hand-rolled `city + postal_code` assembly is banned platform-wide.
      expect(src).not.toMatch(/postal_code/);
    }
  });
});
