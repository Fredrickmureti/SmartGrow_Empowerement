/**
 * ESLint rule: no-dialog-crud-in-admin
 *
 * The Platform Admin four-pattern rule (docs/design-system/audit/platform-admin.md)
 * forbids form-bearing `Dialog` / `Sheet` overlays inside
 * `src/pages/admin/**` and `src/components/admin/**`. Real CRUD belongs
 * on a dedicated workspace route (`RecordFormShell`) or a wizard
 * (`WizardShell`). Read-mostly quick looks belong in `DocumentPeekShell`.
 * Single-question confirmations use `AlertDialog` (which is exempt).
 *
 * The rule fires when `<DialogContent>` or `<SheetContent>` renders a
 * descendant form control (`<input>`, `<textarea>`, `<Select>`, `<form>`
 * with fields). It skips overlays that only contain buttons and prose
 * (which pattern-classify as confirmation).
 *
 * Add `// ADMIN-DIALOG-EXEMPT: <reason>` on the JSX element above the
 * `<DialogContent>` opening tag to opt out — the audit doc explicitly
 * exempts inline provider/setting toggles (MFA, bank providers, mpesa,
 * exchange rates, data reset, AI providers, storage monitor, dashboard
 * chrome).
 */

const OVERLAY_TAGS = new Set(["DialogContent", "SheetContent"]);
const FORM_CONTROL_TAGS = new Set([
  "Input",
  "Textarea",
  "Select",
  "SelectTrigger",
  "Combobox",
  "DatePicker",
  "Checkbox",
  "RadioGroup",
  "Switch",
]);
const NATIVE_FORM_TAGS = new Set(["input", "textarea", "select"]);

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Admin CRUD dialogs are forbidden — use a workspace route (RecordFormShell) or a wizard.",
    },
    schema: [],
    messages: {
      forbidden:
        "<{{tag}}> under src/{pages,components}/admin/** contains form controls. " +
        "Platform Admin CRUD must live on a workspace route " +
        "(AdminRecordForm) or a wizard (AdminWizard). See " +
        "docs/design-system/audit/platform-admin.md. Add " +
        "// ADMIN-DIALOG-EXEMPT: <reason> to opt out for inline settings toggles.",
    },
  },
  create(context) {
    const sourceCode = context.getSourceCode();

    function tagName(el) {
      if (!el || el.type !== "JSXElement") return null;
      const n = el.openingElement && el.openingElement.name;
      if (!n) return null;
      if (n.type === "JSXIdentifier") return n.name;
      return null;
    }

    function hasExempt(node) {
      // Accept both a leading JS comment and a preceding JSX comment
      // `{/* ADMIN-DIALOG-EXEMPT: ... */}`. JSX comments live inside a
      // JSXExpressionContainer as an inner block-comment token, so
      // `getCommentsBefore` (which looks at leading trivia only) misses
      // them; fall back to a raw-source scan of the lines above the tag.
      const comments = sourceCode.getCommentsBefore(node) || [];
      if (comments.some((c) => /ADMIN-DIALOG-EXEMPT:/.test(c.value))) return true;
      const lines = sourceCode.getLines();
      const startLine = node.loc.start.line; // 1-indexed
      // Scan up to 3 lines above (skips indentation-only whitespace lines).
      for (let i = startLine - 2; i >= Math.max(0, startLine - 5); i--) {
        const l = lines[i];
        if (!l) continue;
        if (/ADMIN-DIALOG-EXEMPT:/.test(l)) return true;
        if (l.trim() === "") continue;
        // Stop once we hit a non-comment / non-blank line above the tag.
        if (!/^\s*(\{\s*\/\*|\/\/|\/\*)/.test(l)) break;
      }
      return false;
    }



    function collectDescendantTags(node, out) {
      if (!node) return;
      if (node.type === "JSXElement") {
        const t = tagName(node);
        if (t) out.add(t);
      }
      const children = node.children || [];
      for (const c of children) {
        if (c.type === "JSXElement" || c.type === "JSXFragment") {
          collectDescendantTags(c, out);
        } else if (c.type === "JSXExpressionContainer") {
          walkExpr(c.expression, out);
        }
      }
    }

    function walkExpr(expr, out) {
      if (!expr) return;
      if (expr.type === "JSXElement" || expr.type === "JSXFragment") {
        collectDescendantTags(expr, out);
      } else if (expr.type === "LogicalExpression" || expr.type === "ConditionalExpression") {
        walkExpr(expr.right ?? expr.consequent, out);
        walkExpr(expr.alternate, out);
      } else if (expr.type === "ArrayExpression") {
        for (const e of expr.elements) walkExpr(e, out);
      } else if (expr.type === "CallExpression") {
        for (const a of expr.arguments) walkExpr(a, out);
      } else if (expr.type === "ArrowFunctionExpression" || expr.type === "FunctionExpression") {
        walkExpr(expr.body, out);
      } else if (expr.type === "BlockStatement") {
        for (const s of expr.body) {
          if (s.type === "ReturnStatement") walkExpr(s.argument, out);
        }
      }
    }

    return {
      JSXElement(node) {
        const name = tagName(node);
        if (!name || !OVERLAY_TAGS.has(name)) return;
        if (hasExempt(node)) return;

        const tags = new Set();
        collectDescendantTags(node, tags);
        let hasForm = false;
        for (const t of tags) {
          if (FORM_CONTROL_TAGS.has(t) || NATIVE_FORM_TAGS.has(t)) {
            hasForm = true;
            break;
          }
        }
        if (!hasForm) return;

        context.report({
          node: node.openingElement,
          messageId: "forbidden",
          data: { tag: name },
        });
      },
    };
  },
};
