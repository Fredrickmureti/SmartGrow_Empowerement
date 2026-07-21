/**
 * ESLint rule: no-dialog-for-pos-workspace
 *
 * The POS workstation state chart
 * (`docs/architecture/POS_WORKSTATION_STATES.md`) requires phase-change
 * surfaces (payment/tender, receipt, return, held, history) to be
 * ROUTED WORKSPACES rendered under `/pos/terminal/:id/<phase>`, not
 * `<Dialog>` overlays. Sale-scoped popups may still exist as sheets
 * hosted by `SheetShell`, but the workspace files themselves must not
 * import the raw Radix Dialog primitive.
 *
 * This rule fires inside `src/apps/pos/terminal/**` when a file imports
 * from `@/components/ui/dialog` (or a relative `../ui/dialog` path).
 * Companion architecture test:
 * `src/__tests__/architecture.pos-workspace-dialogs.test.ts`.
 */

const FORBIDDEN_SOURCES = new Set([
  "@/components/ui/dialog",
]);

function isForbidden(source) {
  if (FORBIDDEN_SOURCES.has(source)) return true;
  // Handle relative variants like "../../components/ui/dialog".
  return /(^|\/)components\/ui\/dialog$/.test(source);
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw Dialog imports inside src/apps/pos/terminal/**; use routed workspaces or SheetShell instead.",
    },
    schema: [],
    messages: {
      dialogImport:
        "POS workstation files must not import `{{source}}`. Phase-change surfaces belong on a routed workspace under /pos/terminal/:id/<phase>; sale-scoped popups must go through SheetShell. See docs/architecture/POS_WORKSTATION_STATES.md.",
    },
  },
  create(context) {
    const filename = context.getFilename().replace(/\\/g, "/");
    if (!filename.includes("/src/apps/pos/terminal/")) {
      return {};
    }
    return {
      ImportDeclaration(node) {
        const source = node.source && node.source.value;
        if (typeof source === "string" && isForbidden(source)) {
          context.report({
            node: node.source,
            messageId: "dialogImport",
            data: { source },
          });
        }
      },
    };
  },
};
