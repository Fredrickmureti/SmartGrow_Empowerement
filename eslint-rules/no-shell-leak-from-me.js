/**
 * no-shell-leak-from-me
 *
 * The Employee Self-Service portal (`/me/*`) must render as one cohesive
 * shell. Links or programmatic navigation from `src/pages/me/**` or
 * `src/apps/me/**` into the admin shells (`/hr/*`, `/settings/*`,
 * `/notifications`) punch the employee out of the portal and re-parent
 * them under `PlatformAppLayout`, which is the exact bug this audit is
 * closing.
 *
 * Allowed exceptions (manager drill-downs that legitimately jump shells):
 *   - `/hr/talent/reviews`  — manager review workspace
 *   - `/hr/talent/development` — manager development-plan workspace
 *   - Anything under `/auth/*` and `/login` — sign-out flow
 *
 * Paired with the arch test `ess-portal-shell.test.ts` for CI-cache
 * resilience.
 */
const BLOCKED_PREFIXES = ["/hr/", "/settings/", "/notifications"];
const ALLOWLIST = [
  "/hr/talent/reviews",
  "/hr/talent/development",
];

function isBlocked(value) {
  if (typeof value !== "string") return false;
  if (ALLOWLIST.some((p) => value === p || value.startsWith(p + "/"))) return false;
  if (value === "/notifications" || value.startsWith("/notifications?") || value.startsWith("/notifications/")) return true;
  return BLOCKED_PREFIXES.some((p) => value.startsWith(p));
}

function stringFromNode(node) {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral" && node.quasis.length === 1) return node.quasis[0].value.cooked;
  return null;
}

export default {
  meta: {
    type: "problem",
    docs: { description: "Disallow /me pages linking or navigating into /hr, /settings, or /notifications shells." },
    schema: [],
    messages: {
      leak: "Employee self-service page must not link into the '{{shell}}' shell. Route within /me/* or add to the allowlist in eslint-rules/no-shell-leak-from-me.js.",
    },
  },
  create(context) {
    const filename = context.getFilename().replace(/\\/g, "/");
    if (!/\/src\/(pages|apps)\/me\//.test(filename)) return {};

    return {
      // <Link to="/hr/...">, <Navigate to="/hr/...">
      JSXAttribute(node) {
        if (node.name.name !== "to") return;
        const val = node.value;
        if (!val) return;
        let str = null;
        if (val.type === "Literal") str = typeof val.value === "string" ? val.value : null;
        else if (val.type === "JSXExpressionContainer") str = stringFromNode(val.expression);
        if (isBlocked(str)) {
          context.report({ node, messageId: "leak", data: { shell: str } });
        }
      },
      // navigate("/hr/..."), navigate({ to: "/hr/..." })
      CallExpression(node) {
        const callee = node.callee;
        const name = callee.type === "Identifier" ? callee.name : callee.type === "MemberExpression" && callee.property.type === "Identifier" ? callee.property.name : null;
        if (name !== "navigate" && name !== "push" && name !== "replace") return;
        const arg = node.arguments[0];
        if (!arg) return;
        let str = stringFromNode(arg);
        if (!str && arg.type === "ObjectExpression") {
          const toProp = arg.properties.find((p) => p.type === "Property" && ((p.key.type === "Identifier" && p.key.name === "to") || (p.key.type === "Literal" && p.key.value === "to")));
          if (toProp) str = stringFromNode(toProp.value);
        }
        if (isBlocked(str)) {
          context.report({ node, messageId: "leak", data: { shell: str } });
        }
      },
    };
  },
};
