/**
 * Returns audit, Phase 7.2 — architecture guards for the WMS Returns subsystem.
 *
 * Three invariants are enforced here:
 *  1. No client code writes `wms_return_orders` / `wms_return_lines` directly.
 *     Every mutation goes through a server-guarded `wms_*` RPC so the FSM,
 *     row_version and outbox emission stay authoritative.
 *  2. Returns paperwork leaves the app through `dispatchReturnDocument` only —
 *     no page or hook may reach `printDocumentIntent` / `generate-document` /
 *     `ensureDocumentRecord` on its own.
 *  3. Every returns document kind has a matching document template seeded by
 *     `wms_seed_returns_document_templates`, so paperwork never silently falls
 *     back to the invoice-shaped default layout.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../../");
const MIGRATIONS = path.resolve(__dirname, "../../../supabase/migrations");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "test") continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

const FILES = walk(SRC);
const rel = (p: string) => path.relative(SRC, p).replace(/\\/g, "/");

describe("WMS Returns — architecture guards", () => {
  it("no client code writes wms_return_orders / wms_return_lines directly", () => {
    const write = /\.from\(\s*["'`]wms_return_(orders|lines)["'`]\s*\)[\s\S]{0,200}?\.(insert|update|upsert|delete)\(/;
    const offenders = FILES.filter((f) => write.test(readFileSync(f, "utf8"))).map(rel);
    expect(offenders, "returns tables are RPC-only writes").toEqual([]);
  });

  it("returns paperwork is dispatched only through dispatchReturnDocument", () => {
    const returnsFiles = FILES.filter(
      (f) =>
        /features\/warehouse\/returns\//.test(rel(f)) ||
        /pages\/warehouse\/ReturnOrders\.tsx$/.test(rel(f)) ||
        /pages\/warehouse-mobile\/MobileReturns\.tsx$/.test(rel(f)),
    );
    const banned = /(printDocumentIntent|ensureDocumentRecord|functions\.invoke\(\s*["'`]generate-document)/;
    const offenders = returnsFiles
      .filter((f) => !/dispatchReturnDocument\.ts$/.test(rel(f)))
      .filter((f) => banned.test(readFileSync(f, "utf8")))
      .map(rel);
    expect(offenders, "use dispatchReturnDocument() instead").toEqual([]);
  });

  it("every returns document kind has a seeded template type", () => {
    const dispatchSrc = readFileSync(
      path.join(SRC, "features/warehouse/returns/dispatchReturnDocument.ts"),
      "utf8",
    );
    const map = dispatchSrc.slice(
      dispatchSrc.indexOf("SOURCE_DOC_TYPE"),
      dispatchSrc.indexOf("export interface DispatchReturnDocumentArgs"),
    );
    const templateTypes = [...map.matchAll(/:\s*"([a-z_]+)"/g)].map((m) => m[1]);
    expect(templateTypes.length).toBeGreaterThanOrEqual(4);

    const seedSql = readdirSync(MIGRATIONS)
      .filter((n) => n.endsWith(".sql"))
      .map((n) => readFileSync(path.join(MIGRATIONS, n), "utf8"))
      .filter((s) => s.includes("wms_seed_returns_document_templates"))
      .join("\n");
    expect(seedSql, "seed function migration must exist").not.toEqual("");

    const missing = templateTypes.filter((t) => !seedSql.includes(`'${t}'`));
    expect(missing, "template types missing from the returns seed function").toEqual([]);
  });
});
