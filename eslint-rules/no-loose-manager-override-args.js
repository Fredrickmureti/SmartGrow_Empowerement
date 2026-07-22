/**
 * ESLint rule: no-loose-manager-override-args
 *
 * Enforces Stage 1 of the POS refund/reversal remediation
 * (`.lovable/plan.md` → "TerminalSessionEnvelope"): the
 * `useManagerOverride` hook MUST NOT be called with loose scalar
 * arguments like `useManagerOverride(orgId, businessId)`. The only
 * legal call shapes are:
 *
 *   useManagerOverride()
 *   useManagerOverride({ businessId, ...otherEnvelopeOverrides })
 *
 * The single-scalar form `useManagerOverride(currentOrg?.id)` was the
 * exact defect that produced the "Company not selected → Override
 * denied → An unexpected error occurred" cascade in the POS refund
 * flow: business_id was silently dropped at five call sites. Rejecting
 * the loose-argument shape at lint time makes that class of bug
 * impossible to reintroduce.
 *
 * Report legal shapes:
 *   - zero arguments
 *   - exactly one argument that is an object expression (or a
 *     TypeScript satisfies/as expression whose target is one) OR a
 *     reference the code splitter cannot statically inspect (we accept
 *     it and rely on the TypeScript signature to enforce the shape).
 *
 * Report illegal shapes:
 *   - 2+ arguments
 *   - 1 argument that is a member expression / identifier that clearly
 *     looks like a scalar id (heuristic: ends with `.id` or matches
 *     /(orgId|organizationId|businessId|companyId)/i).
 */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid loose scalar arguments to useManagerOverride; use the envelope-object form.",
    },
    schema: [],
    messages: {
      tooManyArgs:
        "useManagerOverride() takes zero or one arguments. Pass an envelope-override object like `useManagerOverride({ businessId: shift?.business_id })` — never loose scalar IDs. See .lovable/plan.md → Stage 1.",
      looseScalar:
        "useManagerOverride() must be called with zero arguments or a single envelope-override object. Passing a scalar id (`{{arg}}`) was the root cause of the 'Company not selected' regression. Use `useManagerOverride()` to read the ambient envelope, or `useManagerOverride({ businessId })` for rescue flows.",
    },
  },
  create(context) {
    const looksLikeScalarId = (source) => {
      if (!source) return false;
      if (/\.id\s*$/.test(source)) return true;
      if (/(orgId|organizationId|businessId|companyId)\b/i.test(source)) return true;
      return false;
    };

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (!callee || callee.type !== "Identifier") return;
        if (callee.name !== "useManagerOverride") return;

        if (node.arguments.length > 1) {
          context.report({ node, messageId: "tooManyArgs" });
          return;
        }
        if (node.arguments.length === 1) {
          const arg = node.arguments[0];
          // Object literal is always fine.
          if (arg.type === "ObjectExpression") return;
          // Spread / TS assertions wrapping an object literal — accept.
          if (
            arg.type === "TSAsExpression" ||
            arg.type === "TSSatisfiesExpression" ||
            arg.type === "TSNonNullExpression"
          ) {
            if (arg.expression && arg.expression.type === "ObjectExpression") return;
          }
          // Heuristic: anything that stringifies as a scalar id is a bug.
          const src = context.getSourceCode().getText(arg);
          if (looksLikeScalarId(src)) {
            context.report({
              node,
              messageId: "looseScalar",
              data: { arg: src },
            });
          }
        }
      },
    };
  },
};
