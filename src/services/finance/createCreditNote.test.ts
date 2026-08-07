import { describe, expect, it } from "vitest";
import { serializeCreateCreditNoteRequest, type CreateCreditNotePayload } from "./createCreditNote";

describe("createCreditNoteAtomic wire contract", () => {
  it("serializes exactly one named _payload argument", () => {
    const payload: CreateCreditNotePayload = {
      organization_id: "org-id",
      business_id: "business-id",
      branch_id: null,
      contact_id: "contact-id",
      invoice_id: "invoice-id",
      issue_date: "2026-08-07",
      reason: "Invoice credit",
      notes: null,
      items: [{ description: "Credit", quantity: 1, unit_price: 9000, line_total: 9000 }],
      source_return_id: null,
      issue: false,
    };

    const request = JSON.parse(serializeCreateCreditNoteRequest(payload));
    expect(Object.keys(request)).toEqual(["_payload"]);
    expect(request._payload).toEqual(payload);
    expect(request._payload.items[0].line_total).toBe(9000);
  });
});