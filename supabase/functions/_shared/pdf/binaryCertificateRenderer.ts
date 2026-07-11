/**
 * binaryCertificateRenderer
 *
 * Renders a statutory certificate by materialising an official master workbook
 * (uploaded to the localization pack as a `xlsx_binary` template) and writing
 * per-employee token values into named cells.
 *
 * Contract with the template body:
 *   {
 *     "kind": "xlsx_binary",
 *     "asset_key": "certificates/P9A.xlsx",
 *     "master_sha256": "...",
 *     "cell_bindings": {
 *       "static": { "<Cell>": { "token": "employer.name" } },
 *       "monthly_grid": {
 *         "start_row": 15, "end_row": 26,
 *         "columns": [ { "col": "B", "rule_code": "basic_salary" }, ... ]
 *       }
 *     }
 *   }
 *
 * Merged cells, borders, formulas and print settings from the master survive
 * unchanged because ExcelJS only rewrites the cells we touch.
 */
import ExcelJS from "npm:exceljs@4.4.0";

type Nullish = null | undefined;

export interface XlsxCellBindingSpec {
  static?: Record<string, { token: string; format?: string }>;
  monthly_grid?: {
    start_row: number;
    end_row: number;
    columns: Array<{ col: string; rule_code?: string; token?: string }>;
  };
}

export interface BinaryCertificateBody {
  kind: "xlsx_binary";
  asset_key: string;
  master_sha256?: string;
  cell_bindings: XlsxCellBindingSpec;
}

export interface BinaryCertificateContext {
  employer: Record<string, unknown>;
  employee: Record<string, unknown>;
  fiscal_year: number;
  currency?: string;
  monthly: Array<{ month: number; rule_code: string; amount: number }>;
  totals: Record<string, number>;
  serial_number: string;
  generated_at: string;
}

export interface AssetFetcher {
  (assetKey: string): Promise<Uint8Array>;
}

function resolveDerived(path: string, ctx: BinaryCertificateContext): unknown {
  // Small, explicit registry of derived tokens produced by the pack
  // authoring layer (not stored on the context object).
  switch (path) {
    case "header.title_with_year":
      return `P9 TAX DEDUCTION CARD YEAR ${ctx.fiscal_year}`;
    case "header.year":
      return String(ctx.fiscal_year);
    default:
      return null;
  }
}

function resolveToken(token: string, ctx: BinaryCertificateContext): unknown {
  if (token.startsWith("header.")) return resolveDerived(token, ctx);
  const parts = token.split(".");
  let cur: any = ctx;
  for (const p of parts) {
    if (cur == null) return null;
    cur = cur[p];
  }
  return cur ?? null;
}

function coerceForCell(v: unknown): string | number | Nullish {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? "YES" : "NO";
  return String(v);
}

/**
 * Normalise the two authoring shapes for `cell_bindings` into the
 * canonical `{ static, monthly_grid }` form the writer loop expects.
 *
 * Editor / migration shape (array):
 *   [ { cell:"P4", kind:"token"|"derived", source:"employer.tax_pin" }, ... ]
 * Canonical shape (object):
 *   { static: { "P4": { token:"employer.tax_pin" } }, monthly_grid: {...} }
 *
 * Also accepts `monthly_grid.columns[].column` as an alias for `.col`.
 */
function normaliseBindings(raw: any): XlsxCellBindingSpec {
  if (!raw || typeof raw !== "object") return {};
  const out: XlsxCellBindingSpec = {};

  if (Array.isArray(raw)) {
    const staticMap: Record<string, { token: string; format?: string }> = {};
    for (const b of raw) {
      if (!b || typeof b !== "object") continue;
      const addr = String(b.cell ?? b.address ?? "").trim();
      const src = String(b.token ?? b.source ?? "").trim();
      if (!addr || !src) continue;
      staticMap[addr] = { token: src, format: b.format };
    }
    if (Object.keys(staticMap).length) out.static = staticMap;
    return out;
  }

  if (raw.static && typeof raw.static === "object") out.static = raw.static;
  if (Array.isArray(raw.cells)) {
    const merged: Record<string, { token: string; format?: string }> = { ...(out.static ?? {}) };
    for (const b of raw.cells) {
      const addr = String(b.cell ?? b.address ?? "").trim();
      const src = String(b.token ?? b.source ?? "").trim();
      if (addr && src) merged[addr] = { token: src, format: b.format };
    }
    if (Object.keys(merged).length) out.static = merged;
  }
  if (raw.monthly_grid) {
    const g = raw.monthly_grid;
    out.monthly_grid = {
      start_row: Number(g.start_row),
      end_row: Number(g.end_row),
      columns: Array.isArray(g.columns)
        ? g.columns.map((c: any) => ({
            col: String(c.col ?? c.column ?? "").trim(),
            rule_code: c.rule_code,
            token: c.token,
          })).filter((c: any) => c.col)
        : [],
    };
  }
  return out;
}

export async function renderBinaryCertificateXlsx(
  body: BinaryCertificateBody,
  ctx: BinaryCertificateContext,
  fetchAsset: AssetFetcher,
): Promise<Uint8Array> {
  if (!body || body.kind !== "xlsx_binary") {
    throw new Error("binaryCertificateRenderer: body.kind must be 'xlsx_binary'");
  }
  if (!body.asset_key) {
    throw new Error("binaryCertificateRenderer: body.asset_key is required");
  }
  const masterBytes = await fetchAsset(body.asset_key);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(masterBytes.buffer.slice(
    masterBytes.byteOffset,
    masterBytes.byteOffset + masterBytes.byteLength,
  ));
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("binaryCertificateRenderer: master workbook has no sheets");

  const bindings = normaliseBindings(body.cell_bindings);

  const staticMap = bindings.static ?? {};
  for (const [addr, spec] of Object.entries(staticMap)) {
    const val = resolveToken(spec.token, ctx);
    const cell = ws.getCell(addr);
    cell.value = coerceForCell(val);
  }

  const grid = bindings.monthly_grid;
  if (grid && Array.isArray(grid.columns) && grid.start_row && grid.end_row) {
    const byMonth = new Map<number, Map<string, number>>();
    for (const r of ctx.monthly ?? []) {
      const m = Number(r.month);
      if (!byMonth.has(m)) byMonth.set(m, new Map());
      byMonth.get(m)!.set(r.rule_code, Number(r.amount) || 0);
    }
    for (let month = 1; month <= 12; month++) {
      const row = grid.start_row + (month - 1);
      if (row > grid.end_row) break;
      const monthMap = byMonth.get(month) ?? new Map<string, number>();
      for (const col of grid.columns) {
        if (!col.col || !col.rule_code) continue;
        const amount = monthMap.get(col.rule_code) ?? 0;
        ws.getCell(`${col.col}${row}`).value = amount;
      }
    }
  }


  const out = await wb.xlsx.writeBuffer();
  return new Uint8Array(out as ArrayBuffer);
}

/**
 * Convenience fetcher for pack assets stored via URL. Handles the
 * Lovable CDN path prefix (`/__l5e/…`) by resolving against the request
 * origin fallback.
 */
export function makeUrlAssetFetcher(
  urlByAssetKey: (assetKey: string) => string | null,
  originForRelative?: string,
): AssetFetcher {
  return async (assetKey: string) => {
    const rawUrl = urlByAssetKey(assetKey);
    if (!rawUrl) throw new Error(`binaryCertificateRenderer: no source_url for asset ${assetKey}`);
    let url = rawUrl;
    if (url.startsWith("/") && originForRelative) {
      url = `${originForRelative.replace(/\/$/, "")}${url}`;
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`binaryCertificateRenderer: fetch ${url} -> ${res.status}`);
    const ab = await res.arrayBuffer();
    return new Uint8Array(ab);
  };
}