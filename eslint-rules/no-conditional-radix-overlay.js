/**
 * ESLint rule: no-conditional-radix-overlay
 *
 * Forbids rendering a Radix overlay component (Dialog/Sheet/AlertDialog/Drawer)
 * inside a JSX logical-AND short-circuit:
 *
 *   {showDialog && <Dialog>...</Dialog>}     // BAD — unmount-while-open leak
 *
 * The correct pattern is to ALWAYS mount the overlay and toggle visibility
 * via the `open` prop:
 *
 *   <Dialog open={showDialog} onOpenChange={setShowDialog}>...</Dialog>
 *
 * Why: Radix sets `pointer-events: none` on `<body>` when an overlay opens
 * and removes it on close. If the overlay is unmounted while still open
 * (which happens when the gating condition flips to falsy), the cleanup
 * never runs and the entire app becomes unclickable while still scrolling.
 *
 * Add `// OVERLAY-EXEMPT: <reason>` on the line above to opt out for a
 * legitimately-conditional case (e.g. lazy-loaded heavyweight overlay
 * gated by a feature flag).
 */

const OVERLAY_NAMES = new Set([
  "Dialog",
  "Sheet",
  "AlertDialog",
  "Drawer",
]);

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Radix overlays must be always-mounted; toggle visibility via `open`, never via `&&`.",
    },
    schema: [],
    messages: {
      conditional:
        "Radix `{{ name }}` is rendered inside a `&&` short-circuit. " +
        "When the condition flips to false the overlay is unmounted while " +
        "still open, leaving `pointer-events: none` on <body> and freezing " +
        "the entire UI. Always mount it and pass the condition to `open=` instead.",
    },
  },
  create(context) {
    const sourceCode = context.getSourceCode();

    function hasExemptComment(node) {
      const comments = sourceCode.getCommentsBefore(node) || [];
      return comments.some((c) => /OVERLAY-EXEMPT:/.test(c.value));
    }

    function jsxName(el) {
      if (!el || el.type !== "JSXElement") return null;
      const name = el.openingElement && el.openingElement.name;
      if (!name) return null;
      if (name.type === "JSXIdentifier") return name.name;
      return null;
    }

    return {
      LogicalExpression(node) {
        if (node.operator !== "&&") return;
        const right = node.right;
        const name = jsxName(right);
        if (!name || !OVERLAY_NAMES.has(name)) return;
        if (hasExemptComment(node)) return;
        // Skip if the overlay already accepts an `open` prop sourced from the
        // condition (rare but valid: developer wrote `cond && <Dialog open={cond}>`).
        // Even then, the unmount race remains, so we still flag it.
        context.report({
          node: right,
          messageId: "conditional",
          data: { name },
        });
      },
    };
  },
};
