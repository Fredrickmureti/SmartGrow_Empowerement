import { describe, expect, it } from "vitest";
import {
  serializeCreateCreditNoteRequest,
  type CreateCreditNotePayload,
} from "./createCreditNote";

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

  it("carries the invoice-line link and the idempotency key to the server", () => {
    const payload: CreateCreditNotePayload = {
      organization_id: "org-id",
      business_id: "business-id",
      branch_id: null,
      contact_id: "contact-id",
      invoice_id: "invoice-id",
      issue_date: "2026-08-09",
      reason: "Product return",
      notes: null,
      items: [{ invoice_item_id: "invoice-item-id", quantity: 2, sort_order: 0 }],
      source_return_id: null,
      issue: false,
      client_request_id: "req-1",
    };

    const request = JSON.parse(serializeCreateCreditNoteRequest(payload));
    // Provenance must survive the wire: it is what makes the credit ceiling,
    // the lineage query and the historical price/tax resolution possible.
    expect(request._payload.items[0].invoice_item_id).toBe("invoice-item-id");
    expect(request._payload.client_request_id).toBe("req-1");
  });
});
