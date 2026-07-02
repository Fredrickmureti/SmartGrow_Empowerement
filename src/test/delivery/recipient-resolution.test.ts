import { describe, it, expect } from "vitest";
import { looksLikeUUID, resolveRecipientName, stripDeliveryNoteSystemTokens } from "@/lib/looksLikeUUID";

describe("looksLikeUUID", () => {
  it("matches canonical UUID strings", () => {
    expect(looksLikeUUID("87b86b09-fdf8-43af-a209-590c4d6b1415")).toBe(true);
    expect(looksLikeUUID("  87b86b09-fdf8-43af-a209-590c4d6b1415  ")).toBe(true);
  });
  it("rejects names, empties, and partial UUIDs", () => {
    expect(looksLikeUUID("Jane Doe")).toBe(false);
    expect(looksLikeUUID("")).toBe(false);
    expect(looksLikeUUID("87b86b09")).toBe(false);
    expect(looksLikeUUID(null)).toBe(false);
    expect(looksLikeUUID(undefined)).toBe(false);
  });
});

describe("resolveRecipientName priority chain", () => {
  it("prefers the linked contact name", () => {
    expect(
      resolveRecipientName({
        received_by_contact: { name: "Acme Warehouse" },
        delivery_proof_name: "POD Person",
        received_by: "Legacy Text",
      }),
    ).toBe("Acme Warehouse");
  });
  it("falls back to POD name when no contact", () => {
    expect(
      resolveRecipientName({
        received_by_contact: null,
        delivery_proof_name: "Jane",
        received_by: "Legacy Text",
      }),
    ).toBe("Jane");
  });
  it("falls back to staff user full_name when no contact or POD", () => {
    expect(
      resolveRecipientName({
        received_by_contact: null,
        delivery_proof_name: null,
        received_by_user: { full_name: "Alex Staff" },
        received_by: "Legacy Text",
      }),
    ).toBe("Alex Staff");
  });
  it("skips staff user when name looks like a UUID", () => {
    expect(
      resolveRecipientName({
        received_by_user: { full_name: "87b86b09-fdf8-43af-a209-590c4d6b1415" },
        received_by: "Legacy Text",
      }),
    ).toBe("Legacy Text");
  });
  it("falls back to legacy text when nothing else", () => {
    expect(
      resolveRecipientName({ received_by: "John at gate" }),
    ).toBe("John at gate");
  });
  it("never returns a UUID", () => {
    expect(
      resolveRecipientName({
        received_by_contact: null,
        delivery_proof_name: "87b86b09-fdf8-43af-a209-590c4d6b1415",
        received_by: "87b86b09-fdf8-43af-a209-590c4d6b1415",
      }),
    ).toBeNull();
  });
});

describe("stripDeliveryNoteSystemTokens", () => {
  it("strips bare token", () => {
    expect(stripDeliveryNoteSystemTokens("Hello [auto-from-invoice:87b86b09-fdf8-43af-a209-590c4d6b1415] world"))
      .toBe("Helloworld");
  });
  it("strips the full Auto-created phrase", () => {
    expect(
      stripDeliveryNoteSystemTokens(
        "Auto-created from invoice INV-00001 [auto-from-invoice:87b86b09-fdf8-43af-a209-590c4d6b1415]",
      ),
    ).toBeNull();
  });
  it("returns null for empty input", () => {
    expect(stripDeliveryNoteSystemTokens(null)).toBeNull();
    expect(stripDeliveryNoteSystemTokens("")).toBeNull();
  });
  it("preserves user-authored text", () => {
    expect(stripDeliveryNoteSystemTokens("Customer wants morning delivery"))
      .toBe("Customer wants morning delivery");
  });
});
