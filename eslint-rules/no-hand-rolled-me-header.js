/**
 * no-hand-rolled-me-header
 *
 * Any `/src/pages/me/**` file that ships an `<h1>` with the platform's
 * hand-rolled header sizing classes, OR a `text-2xl font-(semibold|bold)`
 * KPI value block outside the shared `KpiStrip` primitive, is drifting
 * from the design system. ESS pages must use the shared `PageHeader`
 * primitive for titles and `KpiStrip` from `@/components/hr/KpiStrip`
 * for stat tiles so ESS matches the rest of the platform.
 *
 * The paired arch test `me-uses-design-system.test.ts` is the
 * authoritative source; this lint rule surfaces the violation in-editor.
 */

const HEADER_FORBIDDEN = [/text-2xl/, /text-3xl/];
// A large numeric value (KPI tile) — either "text-2xl" together with
// "font-semibold" or "font-bold" on the same element.
const KPI_FORBIDDEN = /text-2xl[^"']*font-(semibold|bold)|font-(semibold|bold)[^"']*text-2xl/;

function readClassName(attr) {
  if (attr.type !== "JSXAttribute" || attr.name.name !== "className" || !attr.value) {
    return "";
  }
  if (attr.value.type === "Literal" && typeof attr.value.value === "string") {
    return attr.value.value;
  }
  if (
    attr.value.type === "JSXExpressionContainer" &&
    attr.value.expression.type === "Literal" &&
    typeof attr.value.expression.value === "string"
  ) {
    return attr.value.expression.value;
  }
  return "";
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "ESS `/me/*` pages must not hand-roll <h1> headers or KPI value blocks. Use `PageHeader` and `KpiStrip` from `@/design-system` / `@/components/hr/KpiStrip`.",
    },
    schema: [],
    messages: {
      handRolled:
        "Hand-rolled <h1> header found in an /me/* page. Replace with <PageHeader title=… /> from @/design-system so the ESS portal matches the platform.",
      handRolledKpi:
        "Hand-rolled KPI value block (text-2xl font-semibold|bold) found in an /me/* page. Replace with <KpiStrip /> from @/components/hr/KpiStrip so ESS tile styling stays consistent.",
    },
  },
  create(context) {
    const filename = context.getFilename().replace(/\\/g, "/");
    if (!filename.includes("/src/pages/me/")) return {};

    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier") return;
        const tag = node.name.name;

        for (const attr of node.attributes) {
          const raw = readClassName(attr);
          if (!raw) continue;

          if (tag === "h1" && HEADER_FORBIDDEN.some((re) => re.test(raw))) {
            context.report({ node, messageId: "handRolled" });
            return;
          }

          if (KPI_FORBIDDEN.test(raw)) {
            context.report({ node, messageId: "handRolledKpi" });
            return;
          }
        }
      },
    };
  },
};
