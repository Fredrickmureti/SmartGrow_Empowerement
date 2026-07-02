import { describe, it, expect } from "vitest";
import {
  resolveGoodsReceiptRecipient,
  resolveRecipientName,
  looksLikeUUID,
} from "@/lib/recipientName";

const UUID = "87b86b09-fdf8-43af-a209-590c4d6b1415";

describe("resolveGoodsReceiptRecipient (round 5)", () => {
  it("prefers a resolved profile name", () => {
    expect(
      resolveGoodsReceiptRecipient({
        received_by_user: { full_name: "Jane Receiver" },
        received_by: UUID,
      }),
    ).toBe("Jane Receiver");
  });

  it("returns null when only a raw UUID is available — never leaks it", () => {
    expect(
      resolveGoodsReceiptRecipient({
        received_by_user: null,
        received_by: UUID,
      }),
    ).toBeNull();
  });

  it("accepts legacy non-UUID free-text as fallback", () => {
    expect(
      resolveGoodsReceiptRecipient({ received_by: "Old text receiver" }),
    ).toBe("Old text receiver");
  });

  it("strips UUID-shaped names that snuck into profile.full_name", () => {
    expect(
      resolveGoodsReceiptRecipient({
        received_by_user: { full_name: UUID },
      }),
    ).toBeNull();
  });
});

describe("DN resolver back-compat through recipientName.ts", () => {
  it("still resolves contact name first", () => {
    expect(
      resolveRecipientName({
        received_by_contact: { name: "ACME Corp" },
        received_by: UUID,
      }),
    ).toBe("ACME Corp");
  });

  it("looksLikeUUID still recognises the canonical uuid form", () => {
    expect(looksLikeUUID(UUID)).toBe(true);
    expect(looksLikeUUID("not a uuid")).toBe(false);
  });
});