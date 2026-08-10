/**
 * Money movement is idempotent on a caller-derived request key.
 *
 * ADR 0027 invariant 6 / ADR 0028 S3d: `payments.client_request_id` and
 * `bill_payments.client_request_id` each carry a partial unique index on
 * `(organization_id, client_request_id)`. That index is only load-bearing
 * if the client actually sends a key — and only *correct* if the key is
 * derived from the payment intent. A `crypto.randomUUID()` minted per
 * click is a fresh key on every retry, so it satisfies the parameter and
 * defeats the guarantee: the second click posts a second payment.
 *
 * This ratchet pins both halves:
 *   1. every settlement RPC call site passes a request key parameter;
 *   2. no request key is derived from a random source.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PROJECT_ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      if (entry === "node_modules" || entry === "test") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = walk(join(PROJECT_ROOT, "src")).filter(
  (f) => !f.includes(`${join("src", "test")}`) && !/\.test\.tsx?$/.test(f),
);

/** RPCs that move money and therefore MUST be idempotent. */
const SETTLEMENT_RPCS = [
  "record_multi_invoice_payment",
  "record_payment_atomic",
  "record_advance_payment",
  "record_multi_bill_payment",
  "record_vendor_advance_payment",
  "apply_vendor_advance_atomic",
  "apply_customer_deposit_atomic",
] as const;

const REQUEST_KEY_PARAM = /_request_id\s*:|_client_request_id\s*:/;

describe("money movement request keys", () => {
  it.each(SETTLEMENT_RPCS)(
    "every %s call site passes a request key",
    (rpc) => {
      const callPattern = new RegExp(`rpc\\(\\s*["'\`]${rpc}["'\`]`);
      const offenders: string[] = [];

      for (const file of FILES) {
        const src = readFileSync(file, "utf8");
        if (!callPattern.test(src)) continue;

        // Inspect the argument object of each call to this RPC.
        for (const match of src.matchAll(new RegExp(callPattern.source, "g"))) {
          const args = src.slice(match.index!, match.index! + 2200);
          if (!REQUEST_KEY_PARAM.test(args)) {
            offenders.push(file.slice(PROJECT_ROOT.length + 1));
          }
        }
      }

      expect(
        offenders,
        `${rpc} called without _request_id / _client_request_id in:\n${offenders.join("\n")}\n` +
          `Pass a key derived from the payment intent so a double-click replays instead of double-paying.`,
      ).toEqual([]);
    },
  );

  it("no settlement request key is derived from a random source", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const src = readFileSync(file, "utf8");
      if (!REQUEST_KEY_PARAM.test(src) && !/requestId/.test(src)) continue;
      if (
        /(?:_request_id|_client_request_id|requestId|clientRequestId)\s*[:=]\s*(?:crypto\.)?randomUUID\(\)/.test(
          src,
        )
      ) {
        offenders.push(file.slice(PROJECT_ROOT.length + 1));
      }
    }
    expect(
      offenders,
      `Random request keys defeat idempotency (a retry gets a new key):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the unified customer payment dialog derives its key deterministically", () => {
    const DIALOG = readFileSync(
      join(PROJECT_ROOT, "src/components/payments/RecordCustomerPaymentDialog.tsx"),
      "utf8",
    );
    expect(DIALOG).toMatch(/export function makeCustomerPaymentRequestId/);
    expect(DIALOG).not.toMatch(/randomUUID\(\)/);
    // Sorting the allocation fingerprint keeps the key stable regardless of
    // the order the operator ticked the invoices.
    expect(DIALOG).toMatch(/\.sort\(\)/);
  });

  it("the bill payment dialog derives its key deterministically", () => {
    const DIALOG = readFileSync(
      join(PROJECT_ROOT, "src/components/bills/RecordBillPaymentDialog.tsx"),
      "utf8",
    );
    expect(DIALOG).toMatch(/export function makeVendorPaymentRequestId/);
    expect(DIALOG).not.toMatch(/randomUUID\(\)/);
    expect(DIALOG).toMatch(/\.sort\(\)/);
  });

  /**
   * The RPC-level check above only sees the hook that owns the `supabase.rpc`
   * call. A UI wrapper that omits `requestId` leaves the hook forwarding
   * `null`, which silently disables the server-side replay guard.
   */
  it("every caller of a settlement hook wrapper passes requestId", () => {
    const WRAPPERS = ["recordMultiBillPayment", "recordMultiInvoicePayment"];
    const offenders: string[] = [];

    for (const file of FILES) {
      if (file.includes(join("src", "hooks"))) continue; // hook definitions
      const src = readFileSync(file, "utf8");
      for (const wrapper of WRAPPERS) {
        const pattern = new RegExp(`await\\s+${wrapper}\\(\\{`, "g");
        for (const match of src.matchAll(pattern)) {
          const args = src.slice(match.index!, match.index! + 1600);
          if (!/requestId\s*[:,}]/.test(args)) {
            offenders.push(`${file.slice(PROJECT_ROOT.length + 1)} → ${wrapper}`);
          }
        }
      }
    }

    expect(
      offenders,
      `Settlement wrapper called without requestId in:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

