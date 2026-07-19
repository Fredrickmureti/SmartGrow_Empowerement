/**
 * ESLint rule: no-raw-pdf-lib-in-app
 *
 * ADR-0085: `pdf-lib` is a server-only PDF assembly library. The app
 * bundle must never import it — every printable PDF the platform emits
 * is composed by `supabase/functions/_shared/pdf/**` and delivered
 * through `generate-document` + `document_artifacts` (ADR-0084).
 *
 * This rule is scoped in `eslint.config.js` to `src/**` and complements
 * the existing `no-pdf-lib-in-localization-preview` guard (which covers
 * a narrower localization slice with a different rationale).
 *
 * Per-line opt-out: `// RENDERER-EXEMPT: <reason>` on the preceding
 * line, reserved for vetted exceptions (e.g. a temporary migration
 * shim). Any usage must cite a documented reason.
 */

function hasExempt(context, node) {
  const src = context.getSourceCode();
  const before = src.getCommentsBefore(node);
  return before.some((c) => /RENDERER-EXEMPT/.test(c.value));
}

function isPdfLib(spec) {
  return typeof spec === "string" && (spec === "pdf-lib" || spec.startsWith("pdf-lib/"));
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid pdf-lib imports in app code; render through generate-document + _shared/pdf (ADR-0085).",
    },
    schema: [],
    messages: {
      banned:
        "pdf-lib is forbidden in app code (ADR-0085). Route through printClient.print()/generate-document so the artifact is captured in document_artifacts.",
    },
  },
  create(context) {
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
