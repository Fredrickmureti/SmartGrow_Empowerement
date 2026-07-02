/**
 * ESLint rule: require-business-scope
 *
 * Forbids `.eq("organization_id", …)` unless one of the following is true:
 *   1. The same call chain also contains `.eq("business_id", …)`.
 *   2. The variable that received the chain is later reassigned with
 *      `x = x.eq("business_id", …)` in the same function scope (the
 *      "builder-variable" pattern that Supabase's query builder uses).
 *   3. The line is preceded by a `// SCOPE-EXEMPT: <reason>` marker
 *      comment within 3 lines (legacy) or anywhere inside the enclosing
 *      query chain (modern placement above `.from(...)`).
 *
 * This protects against the silent cross-company contamination that broke
 * `PartnerLedger` (architecture audit, finding B1). See
 * `src/lib/businessScopedTables.ts` for the registry of company-scoped
 * tables that this rule guards.
 *
 * NOTE: This rule is intentionally conservative — it flags every
 * `.eq("organization_id")` without `.eq("business_id")`, even on
 * workspace-wide tables. The authoritative table-aware guard is
 * `src/test/architecture/business-scoped-queries.test.ts`, which KNOWS
 * the BUSINESS_SCOPED_TABLES registry. This ESLint rule is a secondary
 * fast-feedback signal; add `// SCOPE-EXEMPT: …` where the query is
 * legitimately workspace-wide.
 */

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require business_id scoping alongside organization_id in Supabase queries",
    },
    schema: [],
    messages: {
      missingBusinessScope:
        'Query filters by `organization_id` but not by `business_id`. ' +
        'Multi-company workspaces will leak data across companies. ' +
        'Add `.eq("business_id", currentBusiness.id)` to the same chain, ' +
        'or precede the call with `// SCOPE-EXEMPT: <reason>` if cross-company is intentional.',
    },
  },

  create(context) {
    const sourceCode = context.getSourceCode();

    /** Walk both UP and DOWN a `.eq().eq()` chain collecting first-arg string literals. */
    function collectEqKeys(node) {
      const keys = [];
      let current = node;
      while (
        current &&
        current.type === "CallExpression" &&
        current.callee.type === "MemberExpression"
      ) {
        if (current.callee.property.name === "eq" && current.arguments.length >= 1) {
          const arg = current.arguments[0];
          if (arg.type === "Literal" && typeof arg.value === "string") {
            keys.push(arg.value);
          }
        }
        current = current.callee.object;
      }
      let parent = node.parent;
      while (
        parent &&
        parent.type === "MemberExpression" &&
        parent.parent &&
        parent.parent.type === "CallExpression"
      ) {
        const call = parent.parent;
        if (parent.property.name === "eq" && call.arguments.length >= 1) {
          const arg = call.arguments[0];
          if (arg.type === "Literal" && typeof arg.value === "string") {
            keys.push(arg.value);
          }
        }
        parent = call.parent;
      }
      return keys;
    }

    /**
     * Follow the .from("…").select(…).eq(…) chain down to the variable
     * declaration / assignment it lives in, and return that variable's name
     * (so we can look for later `<name> = <name>.eq("business_id", …)`
     * reassignments in the same function).
     */
    function enclosingBuilderVariable(node) {
      // Walk up until we hit a VariableDeclarator (let q = supabase.from…)
      // or an AssignmentExpression (q = supabase.from…).
      let cur = node;
      while (cur && cur.parent) {
        const p = cur.parent;
        if (
          p.type === "VariableDeclarator" &&
          p.id &&
          p.id.type === "Identifier"
        ) {
          return { name: p.id.name, scopeNode: findFunctionScope(p) };
        }
        if (
          p.type === "AssignmentExpression" &&
          p.left.type === "Identifier"
        ) {
          return { name: p.left.name, scopeNode: findFunctionScope(p) };
        }
        cur = p;
      }
      return null;
    }

    function findFunctionScope(node) {
      let cur = node;
      while (cur) {
        if (
          cur.type === "FunctionDeclaration" ||
          cur.type === "FunctionExpression" ||
          cur.type === "ArrowFunctionExpression"
        ) {
          return cur;
        }
        cur = cur.parent;
      }
      return null;
    }

    /**
     * Within the given function-scope node, find any statement of the form
     *   <name> = <name>.eq("business_id", …)   // reassignment
     *   <name>.eq("business_id", …)            // void call (rare)
     * Also matches `.eq("business_id", ...)` at any depth in that scope
     * where the receiver's base identifier is `<name>`.
     */
    function scopeHasBusinessIdForVar(scopeNode, varName) {
      if (!scopeNode) return false;
      const scopeSrc = sourceCode.getText(scopeNode);
      // cheap textual check — good enough because var names are unique in scope
      const re1 = new RegExp(
        `\\b${varName}\\s*=\\s*${varName}\\.eq\\(\\s*["']business_id["']`,
      );
      const re2 = new RegExp(
        `\\b${varName}\\.eq\\(\\s*["']business_id["']`,
      );
      return re1.test(scopeSrc) || re2.test(scopeSrc);
    }

    function chainLineRange(node) {
      let start = node.loc.start.line;
      let end = node.loc.end.line;
      let cur = node;
      while (
        cur &&
        cur.type === "CallExpression" &&
        cur.callee.type === "MemberExpression"
      ) {
        cur = cur.callee.object;
        if (cur && cur.loc) start = Math.min(start, cur.loc.start.line);
      }
      let parent = node.parent;
      while (
        parent &&
        (parent.type === "MemberExpression" || parent.type === "CallExpression")
      ) {
        if (parent.loc) end = Math.max(end, parent.loc.end.line);
        parent = parent.parent;
      }
      return { start, end };
    }

    function hasExemptComment(node) {
      const lineNum = node.loc.start.line;
      const range = chainLineRange(node);
      const comments = sourceCode.getAllComments();
      return comments.some(
        (c) =>
          /SCOPE-EXEMPT:/.test(c.value) &&
          ((c.loc.end.line >= lineNum - 3 && c.loc.end.line <= lineNum) ||
            (c.loc.end.line >= range.start - 1 &&
              c.loc.end.line <= range.end)),
      );
    }

    return {
      CallExpression(node) {
        if (
          node.callee.type !== "MemberExpression" ||
          node.callee.property.name !== "eq" ||
          node.arguments.length < 1
        )
          return;

        const arg = node.arguments[0];
        if (arg.type !== "Literal" || typeof arg.value !== "string") return;
        if (!/(^|\.)organization_id$/.test(arg.value)) return;

        const keysInChain = collectEqKeys(node);
        const hasBusinessId = keysInChain.some((k) =>
          /(^|\.)business_id$/.test(k),
        );
        if (hasBusinessId) return;

        // Builder-variable pattern: a later `x = x.eq("business_id", …)` in scope
        const builder = enclosingBuilderVariable(node);
        if (
          builder &&
          scopeHasBusinessIdForVar(builder.scopeNode, builder.name)
        ) {
          return;
        }

        if (hasExemptComment(node)) return;

        context.report({ node, messageId: "missingBusinessScope" });
      },
    };
  },
};
