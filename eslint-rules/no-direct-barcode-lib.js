/**
 * ESLint rule: no-direct-barcode-lib
 *
 * ADR-0085: raw barcode rasterisers (`bwip-js`, the raw `qrcode` node
 * package) may only be imported by the server-side barcode utility
 * under `supabase/functions/_shared/**` and by hardware helpers under
 * `electron/**`. App code must call `printClient.print()` and receive
 * the rendered artefact through `document_artifacts`.
 *
 * `qrcode.react` is EXPLICITLY allowed — it is a React display
 * component for on-screen SVG QR codes (ETIMS previews, scanner
 * pairing, MFA setup) and is not a printable rasteriser.
 *
 * Scoped in `eslint.config.js` to `src/**`.
 *
 * Per-line opt-out: `// RENDERER-EXEMPT: <reason>` on the preceding
 * line.
 */

const BANNED = new Set(["bwip-js", "qrcode"]);

function hasExempt(context, node) {
  const src = context.getSourceCode();
  const before = src.getCommentsBefore(node);
  return before.some((c) => /RENDERER-EXEMPT/.test(c.value));
}

function isBanned(spec) {
  if (typeof spec !== "string") return false;
  // Exact match on the banned package names; sub-paths of banned packages
  // (e.g. `bwip-js/browser`) are also banned. `qrcode.react` is NOT a
  // sub-path of `qrcode` — Node package resolution treats it as a
  // distinct top-level package name.
  if (BANNED.has(spec)) return true;
  for (const name of BANNED) {
    if (spec.startsWith(name + "/")) return true;
  }
  return false;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid raw bwip-js / qrcode imports in app code; route printable barcodes through printClient.print() (ADR-0085). qrcode.react remains allowed.",
    },
    schema: [],
    messages: {
      banned:
        "Raw barcode libraries are forbidden in app code (ADR-0085). Use printClient.print() for printable barcodes, or qrcode.react for on-screen SVG.",
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        if (isBanned(node.source && node.source.value) && !hasExempt(context, node)) {
          context.report({ node, messageId: "banned" });
        }
      },
      CallExpression(node) {
        if (
          node.callee &&
          node.callee.type === "Import" &&
          node.arguments.length &&
          node.arguments[0].type === "Literal" &&
          isBanned(node.arguments[0].value) &&
          !hasExempt(context, node)
        ) {
          context.report({ node, messageId: "banned" });
        }
      },
    };
  },
};
