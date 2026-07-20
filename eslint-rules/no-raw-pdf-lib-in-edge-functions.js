/**
 * ESLint rule: no-raw-pdf-lib-in-edge-functions
 *
 * ADR-0086 (Enterprise Output Platform) — companion to
 * `no-raw-pdf-lib-in-app` (ADR-0085). `pdf-lib` is the low-level PDF
 * assembly library. On the server, exactly ONE module owns it:
 * `supabase/functions/_shared/pdf/**` (the canonical A4 layout engine,
 * exposed as `PdfBuilder` + components). Every other edge function
 * MUST compose that module rather than importing `pdf-lib` directly —
 * otherwise we grow parallel A4 layout engines, which is precisely the
 * drift ADR-0086 exists to prevent.
 *
 * Scope: `supabase/functions/**` (wired in `eslint.config.js`).
 *
 * Allowlist (medium-family owners of low-level PDF assembly):
 *   - `supabase/functions/_shared/pdf/**` — canonical A4 engine.
 *   - `supabase/functions/_shared/receipt/pdf/**` — canonical thermal
 *     PDF renderer (paired with the Line[] AST under ADR-0084).
 *   - Any `*_test.ts` / `*.test.ts` under `supabase/functions/**` —
 *     tests are allowed to inspect emitted bytes with pdf-lib.
 *
 * Per-line opt-out: `// RENDERER-EXEMPT: <reason>` on the preceding
 * line. Reserved for temporary migration shims; must cite ADR + reason.
 */

function hasExempt(context, node) {
  const src = context.getSourceCode();
  const before = src.getCommentsBefore(node);
  return before.some((c) => /RENDERER-EXEMPT/.test(c.value));
}

function isPdfLib(spec) {
  if (typeof spec !== "string") return false;
  // Deno import styles: "pdf-lib", "pdf-lib/…", "https://esm.sh/pdf-lib@…",
  // "https://cdn.skypack.dev/pdf-lib", "npm:pdf-lib@…", etc.
  return (
    spec === "pdf-lib" ||
    spec.startsWith("pdf-lib/") ||
    spec.startsWith("npm:pdf-lib") ||
    /\/pdf-lib(?:@|\/|$)/.test(spec)
  );
}

function isAllowlistedPath(filename) {
  const f = filename.replace(/\\/g, "/");
  if (/\/supabase\/functions\/_shared\/pdf\//.test(f)) return true;
  if (/\/supabase\/functions\/_shared\/receipt\/pdf\//.test(f)) return true;
  if (/\.(test|spec)\.ts$/.test(f)) return true;
  if (/_test\.ts$/.test(f)) return true;
  return false;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid pdf-lib imports in edge functions outside the canonical _shared/pdf and _shared/receipt/pdf owners (ADR-0086).",
    },
    schema: [],
    messages: {
      banned:
        "pdf-lib is forbidden in edge functions outside supabase/functions/_shared/pdf/** (ADR-0086). Compose PdfBuilder + shared components instead of building a parallel A4 layout engine.",
    },
  },
  create(context) {
    const filename = context.getFilename ? context.getFilename() : context.filename;
    if (isAllowlistedPath(filename || "")) return {};
    return {
      ImportDeclaration(node) {
        if (isPdfLib(node.source && node.source.value) && !hasExempt(context, node)) {
          context.report({ node, messageId: "banned" });
        }
      },
      CallExpression(node) {
        if (
          node.callee &&
          node.callee.type === "Import" &&
          node.arguments.length &&
          node.arguments[0].type === "Literal" &&
          isPdfLib(node.arguments[0].value) &&
          !hasExempt(context, node)
        ) {
          context.report({ node, messageId: "banned" });
        }
      },
    };
  },
};
