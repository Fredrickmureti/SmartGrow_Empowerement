/**
 * Wave 7.2 — HR letter snapshot builder tests.
 *
 * HR letters are signed instruments. The snapshot must freeze the prose,
 * the facts grid and the signatory block at dispatch time, and must match
 * the projection in `generate-document/hrLetterFetchers.ts` field-for-field
 * so the rendered bytes are identical on either path.
 */
import { describe, it, expect } from "vitest";
import {
  buildHrOfferLetterSnapshot,
  buildHrContractLetterSnapshot,
  buildHrPromotionLetterSnapshot,
  buildHrWarningLetterSnapshot,
  buildHrLetterSnapshot,
  HR_LETTER_KIND_CODES,
} from "@/services/documents/snapshots/hrLetter";

const org = { id: "org-1", name: "Acme Ltd" };

const offerRow = {
  id: "aaaaaaaa-1111-2222-3333-444444444444",
  organization_id: "org-1",
  business_id: "biz-1",
  currency: "KES",
  base_salary: 1200000,
  bonus_target: 150000,
  start_date: "2026-09-01",
  expires_at: "2026-08-15",
  sent_at: "2026-07-20T09:00:00Z",
  created_at: "2026-07-19T09:00:00Z",
  letter_body: null,
  notes: "Relocation支援 included",
  organization: org,
  business: null,
  application: {
    id: "app-1",
    candidate: { first_name: "Jane", last_name: "Doe", email: "j@x.com" },
    job: { title: "Head of Finance" },
  },
};

const contractRow = {
  id: "bbbbbbbb-1111-2222-3333-444444444444",
  organization_id: "org-1",
  business_id: "biz-1",
  employee_id: "emp-1",
  contract_reference: "CTR-2026-014",
  name: "Permanent — Finance",
  start_date: "2026-08-01",
  end_date: null,
  probation_end_date: "2026-11-01",
  wage: 100000,
  housing_allowance: 20000,
  transport_allowance: null,
  working_schedule: "Mon–Fri 8h",
  approved_at: "2026-07-22T12:00:00Z",
  created_at: "2026-07-21T12:00:00Z",
  notes: null,
  organization: org,
  business: null,
  employee: {
    id: "emp-1",
    first_name: "John",
    last_name: "Smith",
    employee_number: "E-0042",
    work_email: "john@acme.com",
    email: "personal@x.com",
    city: "Nairobi",
    job_position: { title: "Accountant" },
    department: { name: "Finance" },
  },
};

const lifecycleRow = {
  id: "cccccccc-1111-2222-3333-444444444444",
  organization_id: "org-1",
  business_id: "biz-1",
  employee_id: "emp-1",
  occurred_at: "2026-07-25T08:00:00Z",
  created_at: "2026-07-25T08:00:00Z",
  effective_date: "2026-08-01",
  summary: null,
  actor_label: "Ada Lovelace",
  organization: org,
  business: null,
  employee: contractRow.employee,
  payload: {},
};

describe("HR offer letter snapshot", () => {
  it("labels the letter and derives a stable document number", () => {
    const r = buildHrOfferLetterSnapshot(offerRow);
    expect(r.snapshot.document_type).toBe("offer_letter");
    expect(r.snapshot.document_type_label).toBe("OFFER OF EMPLOYMENT");
    expect(r.documentNumber).toBe("OFFER-AAAAAAAA");
    expect(r.documentDate).toBe("2026-07-20");
  });

  it("freezes commercial terms into the facts grid", () => {
    const facts = buildHrOfferLetterSnapshot(offerRow).snapshot.facts as Array<{
      label: string;
      value: string;
    }>;
    expect(facts.map((f) => f.label)).toEqual([
      "Position",
      "Proposed Start Date",
      "Base Salary (annual)",
      "Bonus Target",
      "Offer Expires",
    ]);
    expect(facts[2].value).toContain("KES");
  });

  it("addresses the candidate and carries a countersignature block", () => {
    const s = buildHrOfferLetterSnapshot(offerRow).snapshot as any;
    expect(s.salutation).toBe("Dear Jane Doe,");
    expect(s.recipient.job_title).toBe("Head of Finance");
    expect(s.signatories).toHaveLength(2);
    expect(s.signatories[1].role).toBe("Candidate — acceptance");
  });

  it("has no employee party — the candidate is not yet on payroll", () => {
    const r = buildHrOfferLetterSnapshot(offerRow);
    expect(r.partyKind).toBeNull();
    expect(r.partyId).toBeNull();
  });

  it("falls back to boilerplate prose when no body is stored", () => {
    const s = buildHrOfferLetterSnapshot(offerRow).snapshot as any;
    expect(s.body).toMatch(/pleased to extend/);
    const custom = buildHrOfferLetterSnapshot({
      ...offerRow,
      letter_body: "Bespoke terms.",
    }).snapshot as any;
    expect(custom.body).toBe("Bespoke terms.");
  });
});

describe("HR contract letter snapshot", () => {
  it("uses the contract reference as the document number", () => {
    const r = buildHrContractLetterSnapshot(contractRow);
    expect(r.documentNumber).toBe("CTR-2026-014");
    expect(r.documentDate).toBe("2026-07-22");
    expect(r.partyKind).toBe("employee");
    expect(r.partyId).toBe("emp-1");
  });

  it("omits allowance rows that are absent", () => {
    const labels = (
      buildHrContractLetterSnapshot(contractRow).snapshot.facts as Array<{
        label: string;
      }>
    ).map((f) => f.label);
    expect(labels).toContain("Housing Allowance");
    expect(labels).not.toContain("Transport Allowance");
    expect(labels).not.toContain("End Date");
  });

  it("prefers the work email and includes the postal address", () => {
    const s = buildHrContractLetterSnapshot(contractRow).snapshot as any;
    expect(s.recipient.email).toBe("john@acme.com");
    expect(s.recipient.city).toBe("Nairobi");
    expect(s.recipient.employee_number).toBe("E-0042");
  });
});

describe("HR lifecycle letters", () => {
  it("promotion reads the new title and salary from the event payload", () => {
    const s = buildHrPromotionLetterSnapshot({
      ...lifecycleRow,
      payload: { new_title: "Finance Manager", new_salary: 180000, currency: "KES" },
    }).snapshot as any;
    expect(s.document_type).toBe("promotion_letter");
    expect(s.subject).toBe("Promotion to Finance Manager");
    expect(s.facts).toHaveLength(3);
    expect(s.signatories[0].name).toBe("Ada Lovelace");
  });

  it("warning defaults to a formal severity and carries a right of reply", () => {
    const s = buildHrWarningLetterSnapshot(lifecycleRow).snapshot as any;
    expect(s.subject).toBe("Formal Warning");
    expect(s.closing).toMatch(/five \(5\) working days/);
    expect(s.signatories[1].role).toBe("Employee — acknowledgement");
  });

  it("warning surfaces the stated reason when present", () => {
    const s = buildHrWarningLetterSnapshot({
      ...lifecycleRow,
      payload: { severity: "Final", reason: "Repeated lateness" },
    }).snapshot as any;
    expect(s.subject).toBe("Final Warning");
    expect(s.facts).toContainEqual({
      label: "Reason",
      value: "Repeated lateness",
    });
  });
});

describe("HR letter dispatcher + kinds", () => {
  it("routes each type to its builder", () => {
    expect(buildHrLetterSnapshot("offer_letter", offerRow).snapshot.document_type).toBe(
      "offer_letter",
    );
    expect(
      buildHrLetterSnapshot("contract_letter", contractRow).snapshot.document_type,
    ).toBe("contract_letter");
    expect(
      buildHrLetterSnapshot("warning_letter", lifecycleRow).snapshot.document_type,
    ).toBe("warning_letter");
  });

  it("maps every letter type to a registered document kind", () => {
    expect(HR_LETTER_KIND_CODES).toEqual({
      offer_letter: "hr.offer_letter",
      contract_letter: "hr.contract",
      promotion_letter: "hr.promotion_letter",
      warning_letter: "hr.warning_letter",
    });
  });

  it("is deterministic", () => {
    expect(buildHrContractLetterSnapshot(contractRow)).toEqual(
      buildHrContractLetterSnapshot(contractRow),
    );
  });

  it("always stamps routing tenancy", () => {
    for (const r of [
      buildHrOfferLetterSnapshot(offerRow),
      buildHrContractLetterSnapshot(contractRow),
      buildHrPromotionLetterSnapshot(lifecycleRow),
    ]) {
      expect(r.organizationId).toBe("org-1");
      expect(r.businessId).toBe("biz-1");
    }
  });
});
