/**
 * no-direct-employees-branch-write
 *
 * Forbids client-side writes to `employees.branch_id`. Branch is now a
 * 0..N *assignment*, maintained via `employee_branch_assignments` and the
 * `assign_employee_to_branch` / `transfer_employee_primary_branch` RPCs.
 * The DB also enforces this with a trigger (`_employees_branch_id_write_guard`);
 * this rule is an editor-time convenience so violations surface before commit.
 *
 * Flags any `.update({...branch_id...})` or `.insert({...branch_id...})`
 * whose receiver chain includes `.from("employees")`.
 */
const ALLOW_LIST = new Set([
  // Server-only admin paths (the DB trigger still protects them).
  // Add narrowly-scoped paths here only when you have a justified reason.
]);

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow writing branch_id on the employees table from the client; use assign_employee_to_branch / transfer_employee_primary_branch.",
    },
    schema: [],
    messages: {
      directWrite:
        "Direct write of `employees.branch_id` is forbidden. Use the `assign_employee_to_branch` / `transfer_employee_primary_branch` RPCs (branch is now a 0..N assignment).",
    },
  },
  create(context) {
    const filename = context.getFilename().replace(/\\/g, "/");
    const rel = filename.includes("/src/")
      ? "src/" + filename.split("/src/").pop()
      : filename;
    if (ALLOW_LIST.has(rel)) return {};

    function chainTargetsEmployees(node) {
      let cur = node;
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
          return true;
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
      return false;
    }

    function payloadHasBranchId(arg) {
      if (!arg || arg.type !== "ObjectExpression") return false;
      return arg.properties.some(
        (p) =>
          p.type === "Property" &&
          ((p.key.type === "Identifier" && p.key.name === "branch_id") ||
            (p.key.type === "Literal" && p.key.value === "branch_id")),
      );
    }

    return {
      CallExpression(node) {
        if (
          node.callee.type !== "MemberExpression" ||
          node.callee.property.type !== "Identifier"
        ) {
          return;
        }
        const op = node.callee.property.name;
        if (op !== "update" && op !== "insert" && op !== "upsert") return;
        if (!chainTargetsEmployees(node.callee.object)) return;

        const payload = node.arguments[0];
        if (
          payloadHasBranchId(payload) ||
          (payload &&
            payload.type === "ArrayExpression" &&
            payload.elements.some(payloadHasBranchId))
        ) {
          context.report({ node, messageId: "directWrite" });
        }
      },
    };
  },
};
