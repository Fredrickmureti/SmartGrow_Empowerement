/**
 * ESLint rule: no-pdf-lib-in-localization-preview
 *
 * ADR 0063: statutory returns and certificates render through the SAME
 * country-agnostic HTML + CSS Paged Media compile pipeline
 * (`src/features/localization/lib/engine/compile.ts`,
 * `supabase/functions/_shared/certificate-engine/compile.ts`). pdf-lib
 * hand-drawn cells were the pre-registry rendering path and are now
 * forbidden in localization code — regressions silently reintroduce a
 * second renderer and reopen the parity gap this ADR closed.
 *
 * Scoped in `eslint.config.js` to `src/features/localization/**` plus
 * the `_shared/certificate-engine/` mirror. Edge-function surfaces that
 * still produce the filed PDF via pdf-lib are exempt via file glob;
 * they will migrate in a follow-up.
 *
 * Opt-out per-line: `// LOCALIZATION-EXEMPT: <reason>` on the preceding
 * line (matches the convention used by `no-payslip-lines-in-certificates`).
 */

function hasExempt(context, node) {
  const src = context.getSourceCode();
  const before = src.getCommentsBefore(node);
  return before.some((c) => /LOCALIZATION-EXEMPT/.test(c.value));
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid pdf-lib imports inside localization preview/renderer code; use the HTML + Paged Media compile pipeline instead.",
    },
    schema: [],
    messages: {
      banned:
        'pdf-lib is forbidden in localization preview/renderer code (ADR 0063). Render through the shared certificate-engine compile() pipeline instead.',
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const src = node.source && node.source.value;
        if (typeof src !== "string") return;
        if (src === "pdf-lib" || src.startsWith("pdf-lib/")) {
          if (!hasExempt(context, node)) context.report({ node, messageId: "banned" });
        }
      },
      CallExpression(node) {
        // dynamic import("pdf-lib")
        if (
          node.callee &&
          node.callee.type === "Import" &&
          node.arguments.length &&
          node.arguments[0].type === "Literal" &&
          typeof node.arguments[0].value === "string" &&
          (node.arguments[0].value === "pdf-lib" ||
            node.arguments[0].value.startsWith("pdf-lib/"))
        ) {
          if (!hasExempt(context, node)) context.report({ node, messageId: "banned" });
        }
      },
    };
  },
};