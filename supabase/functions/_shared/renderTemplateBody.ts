// @ts-nocheck — Deno runtime; vitest imports the same module under Node.
/**
 * renderTemplateBody — body-driven renderer for localization-pack
 * certificate / statutory-return templates.
 *
 * Background (ADR 0010 + Round 5 audit, gap C):
 *   The override editor saves a structured block body of the shape
 *     { blocks: [{ id, kind, title, content }] }
 *   where `content` is plain text that may carry `{{token.path}}`
 *   references. Until this module landed, the certificate/return
 *   generators ignored `template.body` entirely and rendered PDFs from
 *   hard-coded column lists, so override edits had no runtime effect.
 *
 * Responsibilities (kept small on purpose):
 *   1. Walk every block, resolve tokens via `_shared/renderTokens` so
 *      misses produce the same `‹unresolved: token›` sentinel the editor
 *      preview shows.
 *   2. Group blocks into `header`, `body`, `totals`, `signature`,
 *      `custom` — generators decide where each group lands relative to
 *      the data table (header → before, totals/signature → after).
 *   3. Stay engine/PDF-library-free so vitest can drive it under Node
 *      without pulling pdf-lib or Deno-only specifiers.
 *
 * Out of scope:
 *   - Structured iteration (`{{rows[*].field}}`) — the editor does not
 *     produce loop blocks yet; defer until a tenant needs it.
 *   - PDF emission — the generator owns layout, not this module.
 */
import { renderTokens, type TokenContext } from "./renderTokens.ts";

export type BlockKind = "header" | "body" | "totals" | "signature" | "custom";

export interface RawBlock {
  id?: string;
  kind?: string;
  title?: string;
  content?: string;
}

export interface RenderedBlock {
  id: string;
  kind: BlockKind;
  title: string;
  text: string;
}

export interface RenderedBody {
  /** Blocks rendered for the area above the data table. */
  beforeTable: RenderedBlock[];
  /** Blocks rendered for the area below the data table. */
  afterTable: RenderedBlock[];
  /** Optional centered footer line (last `signature`/`custom` with kind === 'footer' wins). */
  footerNote: string | null;
  /** Every unresolved token across all blocks (deduped order preserved). */
  misses: string[];
  /** True when the template has no blocks — generator should fall back to legacy columns. */
  isEmpty: boolean;
}

const KNOWN_KINDS: ReadonlySet<BlockKind> = new Set([
  "header",
  "body",
  "totals",
  "signature",
  "custom",
]);

function normaliseKind(raw: unknown): BlockKind {
  if (typeof raw === "string" && KNOWN_KINDS.has(raw as BlockKind)) {
    return raw as BlockKind;
  }
  return "custom";
}

function extractBlocks(body: unknown): RawBlock[] {
  if (!body) return [];
  if (Array.isArray((body as any).blocks)) return (body as any).blocks as RawBlock[];
  // Legacy shapes: object-of-strings { header: "...", body: "...", ... }
  if (typeof body === "object" && !Array.isArray(body)) {
    return Object.entries(body as Record<string, unknown>)
      .filter(([, v]) => typeof v === "string" && v.length > 0)
      .map(([k, v]) => ({ id: k, kind: k, title: k, content: v as string }));
  }
  // Legacy shape: a single string is treated as one body block.
  if (typeof body === "string" && body.length > 0) {
    return [{ id: "body", kind: "body", title: "Body", content: body }];
  }
  return [];
}

/**
 * Resolve every token in every block of a template body. Pure — does not
 * touch the database or the PDF library. Generators consume the returned
 * `beforeTable` / `afterTable` arrays around their existing data table
 * and call `renderAndDiagnose` (or pass `misses` to it) so unresolved
 * tokens are recorded as `payroll_diagnostics` rows.
 */
export function renderTemplateBody(body: unknown, ctx: TokenContext): RenderedBody {
  const blocks = extractBlocks(body);
  if (blocks.length === 0) {
    return { beforeTable: [], afterTable: [], footerNote: null, misses: [], isEmpty: true };
  }

  const beforeTable: RenderedBlock[] = [];
  const afterTable: RenderedBlock[] = [];
  let footerNote: string | null = null;
  const allMisses: string[] = [];
  const seenMiss = new Set<string>();

  for (let i = 0; i < blocks.length; i++) {
    const raw = blocks[i] ?? {};
    const kind = normaliseKind(raw.kind);
    const content = typeof raw.content === "string" ? raw.content : "";
    if (content.trim().length === 0) continue;

    const { rendered, misses } = renderTokens(content, ctx);
    for (const m of misses) {
      if (!seenMiss.has(m)) {
        seenMiss.add(m);
        allMisses.push(m);
      }
    }

    const rb: RenderedBlock = {
      id: typeof raw.id === "string" && raw.id ? raw.id : `block-${i}`,
      kind,
      title: typeof raw.title === "string" ? raw.title : kind,
      text: rendered as string,
    };

    if (kind === "header" || kind === "body") beforeTable.push(rb);
    else if (kind === "totals" || kind === "signature") afterTable.push(rb);
    else {
      // `custom` blocks land after the table; the last one also seeds the
      // footer note so tenants can override the standard one-liner.
      afterTable.push(rb);
      footerNote = rb.text;
    }
  }

  return {
    beforeTable,
    afterTable,
    footerNote,
    misses: allMisses,
    isEmpty: beforeTable.length === 0 && afterTable.length === 0,
  };
}

/**
 * Convenience: project rendered blocks into the `summaryRows` shape the
 * existing `generateReportPdf` already supports. Generators can spread
 * `toSummaryRows(rendered.beforeTable)` before the data table by prepending
 * to `summaryRows`, and `toSummaryRows(rendered.afterTable)` after.
 *
 * Returns `[]` for an empty input so callers can spread unconditionally.
 */
export function toSummaryRows(blocks: RenderedBlock[]): Array<{ label: string; value: string }> {
  return blocks.map((b) => ({ label: b.title || b.kind, value: b.text }));
}
