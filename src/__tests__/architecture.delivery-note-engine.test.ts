import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Delivery Note convergence ratchet (ADR 0011 / 0026).
 *
 * The DB now owns the delivery lifecycle: `status`, dispatch/delivery
 * timestamps and invoice links are not writable by the API roles, and
 * creation/cancellation go through atomic RPCs. These assertions stop the
 * client from growing a second, silent write path.
 */
const SRC = join(process.cwd(), "src");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "test") continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = walk(SRC).map((f) => ({ path: f, text: readFileSync(f, "utf8") }));

describe("delivery note write paths", () => {
  it("never inserts or deletes delivery_notes directly from the client", () => {
    const offenders = FILES.filter(({ text }) =>
      /from\("delivery_notes"\)\s*\.\s*(insert|delete)/.test(text.replace(/\s+/g, " ")),
    ).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("never writes lifecycle-owned delivery note columns from the client", () => {
    const forbidden = /\.from\("delivery_notes"\)[\s\S]{0,400}?\.update\([\s\S]{0,400}?(status|delivered_at|dispatched_at|ready_at|cancelled_at|spawned_invoice_id)\s*:/;
    const offenders = FILES.filter(({ text }) => forbidden.test(text)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  it("disambiguates the two contacts foreign keys when embedding", () => {
    const offenders = FILES.filter(({ text }) => {
      const flat = text.replace(/\s+/g, " ");
      return /from\("delivery_notes"\)/.test(flat) && /contact:contacts\(/.test(flat);
    }).map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});