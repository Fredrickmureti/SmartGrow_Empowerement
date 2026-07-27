/**
 * AST → HTML adapter (Wave 3).
 *
 * Used for email bodies and the developer inspector. This is
 * intentionally a plain-text/HTML sketch: rich HTML email templates
 * belong to the `email_templates` engine and will register here in a
 * later wave.
 */

import type { AstBlock, RenderContext, ResolvedTemplate } from "../types.ts";

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function renderAstToHtml(args: {
  template: ResolvedTemplate;
  context: RenderContext;
  blocks: AstBlock[];
}): Uint8Array {
  const parts: string[] = [];
  parts.push(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(args.template.label)}</title></head><body>`);
  for (const block of args.blocks) {
    parts.push(renderBlock(block, args.context));
  }
  parts.push("</body></html>");
  return new TextEncoder().encode(parts.join("\n"));
}

function renderBlock(block: AstBlock, ctx: RenderContext): string {
  const snap = ctx.document.snapshot as Record<string, unknown>;
  switch (block.type) {
    case "header":
      return `<header><h1>${esc((ctx.business as Record<string, unknown> | null)?.name)}</h1></header>`;
    case "party":
      return `<section class="party party-${block.role}"><h3>${esc(block.role)}</h3><pre>${esc(JSON.stringify(snap[block.role] ?? snap["contact"] ?? {}, null, 2))}</pre></section>`;
    case "meta":
      return `<section class="meta"><ul>${block.fields
        .map((f) => `<li><b>${esc(f)}:</b> ${esc(snap[f])}</li>`)
        .join("")}</ul></section>`;
    case "table":
      return `<table class="preset-${block.preset}"><tbody><tr><td>${esc(block.preset)}</td></tr></tbody></table>`;
    case "totals":
      return `<section class="totals">Total: ${esc(snap["total"] ?? snap["amount_total"] ?? "")}</section>`;
    case "notes":
      return `<section class="notes">${esc(block.text ?? snap["notes"] ?? snap["terms"] ?? "")}</section>`;
    case "footer":
      return `<footer>${esc((ctx.business as Record<string, unknown> | null)?.legal_name)}</footer>`;
    case "text":
      return `<p class="align-${block.align ?? "left"}">${esc(block.text)}</p>`;
    case "divider":
      return `<hr/>`;
    case "spacer":
      return `<div style="height:${block.size === "l" ? 32 : block.size === "s" ? 8 : 16}px"></div>`;
    case "page_break":
      return `<div style="page-break-after:always"></div>`;
    case "barcode":
      return `<code class="barcode barcode-${block.symbology}">${esc(block.data)}</code>`;
    case "fiscal":
      return `<section class="fiscal">${esc(snap["fiscal"] ?? "")}</section>`;
    default:
      return "";
  }
}
