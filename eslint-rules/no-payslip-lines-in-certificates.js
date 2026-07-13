/**
 * ESLint rule: no-payslip-lines-in-certificates
 *
 * ADR 0060: statutory certificates (P9, Certificate of Service, and every
 * future country's annual employee statement) MUST derive figures from
 * `payroll_employee_ytd_rollup` via
 * `supabase/functions/_shared/certificateSourceResolver.ts`. Re-summing
 * raw `payslip_lines` inside a certificate path silently drifts from the
 * canonical YTD projection and defeats the single-writer contract.
 *
 * This rule bans:
 *   - any string literal `"payslip_lines"`
 *   - any Supabase `.from("payslip_lines")` call chain
 * inside the file globs scoped in `eslint.config.js`.
 *
 * Add `// LOCALIZATION-EXEMPT: <reason>` on the line above to opt out.
 */

function hasExempt(context, node) {
  const src = context.getSourceCode();
  const before = src.getCommentsBefore(node);
  return before.some((c) => /LOCALIZATION-EXEMPT/.test(c.value));
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid direct payslip_lines reads inside certificate paths; go through certificateSourceResolver.",
    },
    schema: [],
    messages: {
      banned:
        'Certificates must read YTD via payroll_employee_ytd_rollup (see certificateSourceResolver.ts). "payslip_lines" is forbidden here.',
    },
  },
  create(context) {
    return {
      Literal(node) {
        if (
          typeof node.value === "string" &&
          node.value === "payslip_lines" &&
          !hasExempt(context, node)
        ) {
          context.report({ node, messageId: "banned" });
        }
      },
      TemplateElement(node) {
        const raw = node.value && (node.value.cooked ?? node.value.raw);
        if (
          typeof raw === "string" &&
          /\bpayslip_lines\b/.test(raw) &&
          !hasExempt(context, node)
        ) {
          context.report({ node, messageId: "banned" });
        }
      },
    };
  },
};