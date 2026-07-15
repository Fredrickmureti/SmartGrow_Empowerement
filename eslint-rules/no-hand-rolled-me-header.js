/**
 * no-hand-rolled-me-header
 *
 * Any `/src/pages/me/**` file that ships an `<h1>` with the platform's
 * hand-rolled header sizing classes is drifting from the design system.
 * ESS pages must use the shared `PageHeader` primitive so headings match
 * the rest of the platform.
 *
 * The paired arch test `me-uses-design-system.test.ts` is the
 * authoritative source; this lint rule surfaces the violation in-editor.
 */

const FORBIDDEN_CLASS_PATTERNS = [
  /text-2xl/,
  /text-3xl/,
];

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "ESS `/me/*` pages must not hand-roll <h1> headers. Use the `PageHeader` primitive from `@/design-system`.",
    },
    schema: [],
    messages: {
      handRolled:
        "Hand-rolled <h1> header found in an /me/* page. Replace with <PageHeader title=… /> from @/design-system so the ESS portal matches the platform.",
    },
  },
  create(context) {
    const filename = context.getFilename().replace(/\\/g, "/");
    if (!filename.includes("/src/pages/me/")) return {};

    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "h1") return;
        for (const attr of node.attributes) {
          if (
            attr.type !== "JSXAttribute" ||
            attr.name.name !== "className" ||
            !attr.value
          )
            continue;
          let raw = "";
          if (attr.value.type === "Literal" && typeof attr.value.value === "string") {
            raw = attr.value.value;
          } else if (
            attr.value.type === "JSXExpressionContainer" &&
            attr.value.expression.type === "Literal" &&
            typeof attr.value.expression.value === "string"
          ) {
            raw = attr.value.expression.value;
          }
          if (raw && FORBIDDEN_CLASS_PATTERNS.some((re) => re.test(raw))) {
            context.report({ node, messageId: "handRolled" });
            return;
          }
        }
      },
    };
  },
};