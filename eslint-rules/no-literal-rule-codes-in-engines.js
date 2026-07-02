/**
 * ESLint rule: no-literal-rule-codes-in-engines
 *
 * Forbids payroll/statutory engines from branching on hard-coded
 * `rule_code` / `rule_type` string literals such as "PAYE", "NSSF",
 * "SHIF", "AHL", "NHIF", "VAT". Country-specific behaviour MUST come
 * from validated `parameters` on the localization-pack rows, not from
 * inline JS conditionals — otherwise adding a new country requires a
 * code change instead of a pack edit.
 *
 * Comments and string literals that are clearly NOT a code branch
 * (e.g. log messages, error text containing the word "PAYE") are
 * allowed: the rule only flags equality checks against these literals.
 *
 * Add `// LOCALIZATION-EXEMPT: <reason>` on the line above to opt out
 * (e.g. legacy migration shims).
 */

const BANNED_CODES = new Set([
  "PAYE", "NSSF", "SHIF", "AHL", "NHIF", "NHIT",
  "VAT", "WHT", "PAYG", "SDL", "USC",
]);

function isBannedLiteral(node) {
  return (
    node &&
    node.type === "Literal" &&
    typeof node.value === "string" &&
    BANNED_CODES.has(node.value)
  );
}

function hasExemptComment(context, node) {
  const src = context.getSourceCode();
  const before = src.getCommentsBefore(node);
  return before.some((c) => /LOCALIZATION-EXEMPT/.test(c.value));
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Engines must dispatch off validated rule.parameters, not literal rule_code strings.",
    },
    schema: [],
    messages: {
      banned:
        "Hard-coded rule_code branch on '{{code}}' detected. Use rule.parameters / computation_method instead. Add `// LOCALIZATION-EXEMPT: <reason>` to opt out.",
    },
  },
  create(context) {
    return {
      BinaryExpression(node) {
        if (
          (node.operator === "===" || node.operator === "==" || node.operator === "!==" || node.operator === "!=") &&
          (isBannedLiteral(node.left) || isBannedLiteral(node.right))
        ) {
          if (hasExemptComment(context, node)) return;
          const lit = isBannedLiteral(node.left) ? node.left : node.right;
          context.report({ node, messageId: "banned", data: { code: lit.value } });
        }
      },
      SwitchCase(node) {
        if (isBannedLiteral(node.test)) {
          if (hasExemptComment(context, node)) return;
          context.report({ node, messageId: "banned", data: { code: node.test.value } });
        }
      },
    };
  },
};
