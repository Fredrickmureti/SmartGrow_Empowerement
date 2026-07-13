/**
 * no-direct-employees-read
 *
 * Forbids `.from("employees").select(...)` outside a small write-back
 * allowlist. Operational reads must go through `v_employees_canonical`
 * (list/aggregate) or `v_employees_safe` (single-row PII-masked).
 *
 * The arch test `employees-reads-via-canonical.test.ts` is the
 * authoritative source of truth — this lint rule is an editor-time
 * convenience so developers see the violation before commit.
 */

const ALLOW_LIST = new Set([
  "src/hooks/useEmployees.ts",
  "src/hooks/useEmployeePii.ts",
  "src/routes/api/public/attendance.ingest.ts",
  "src/lib/hr/resolveEmployeeNaturalKeys.ts",
  "src/test/architecture/employees-reads-via-canonical.test.ts",
  "src/test/architecture/no-raw-employees-pii-select.test.ts",
  "src/test/architecture/employees-no-legacy-comp-cols.test.ts",
  "src/test/architecture/employees-lifecycle-writes.test.ts",
]);

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow direct SELECT from the employees table; use v_employees_canonical or v_employees_safe.",
    },
    schema: [],
    messages: {
      directRead:
        "Direct `.from('employees').select(...)` is forbidden. Use `v_employees_canonical` (list/aggregate) or `v_employees_safe` (single-row, PII-masked).",
    },
  },
  create(context) {
    const filename = context.getFilename().replace(/\\/g, "/");
    const rel = filename.includes("/src/")
      ? "src/" + filename.split("/src/").pop()
      : filename;
    if (ALLOW_LIST.has(rel)) return {};

    return {
      // Match call chains like supabase.from("employees").select(...)
      CallExpression(node) {
        if (
          node.callee.type !== "MemberExpression" ||
          node.callee.property.type !== "Identifier" ||
          node.callee.property.name !== "select"
        ) {
          return;
        }
        // Walk the receiver chain looking for `.from("employees")`.
        let cur = node.callee.object;
        let safety = 12;
        while (cur && safety-- > 0) {
          if (
            cur.type === "CallExpression" &&
            cur.callee.type === "MemberExpression" &&
            cur.callee.property.type === "Identifier" &&
            cur.callee.property.name === "from" &&
            cur.arguments.length >= 1 &&
            cur.arguments[0].type === "Literal" &&
            cur.arguments[0].value === "employees"
          ) {
            context.report({ node, messageId: "directRead" });
            return;
          }
          cur =
            cur.type === "CallExpression"
              ? cur.callee.type === "MemberExpression"
                ? cur.callee.object
                : null
              : cur.type === "MemberExpression"
              ? cur.object
              : null;
        }
      },
    };
  },
};
