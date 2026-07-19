/**
 * ESLint rule: no-raw-xlsx-in-app
 *
 * Milestone C.2 — `xlsx` (SheetJS) generation must live server-side in
 * `supabase/functions/_shared/exports/reportXlsx.ts` so the workbook
 * produced by "Download as Excel" matches the workbook attached to a
 * scheduled report matches the workbook re-generated for an artifact
 * replay. Client-side generation drifted from the PDF path (masthead,
 * currency formatting, branding).
 *
 * READ-side APIs (`XLSX.read`, `XLSX.utils.sheet_to_json`) stay legal
 * because bank-statement import and generic file import parse
 * user-uploaded workbooks in the browser. Only the WRITE-side APIs are
 * forbidden.
 *
 * Per-line opt-out: `// RENDERER-EXEMPT: <reason>` on the preceding
 * line, reserved for vetted exceptions.
 */

const BANNED_MEMBERS = new Set([
  "write",
  "writeFile",
  "writeFileXLSX",
]);

const BANNED_UTIL_MEMBERS = new Set([
  "book_new",
  "aoa_to_sheet",
  "json_to_sheet",
  "book_append_sheet",
]);

function hasExempt(context, node) {
  const src = context.getSourceCode();
  // Walk up to the enclosing statement so `// RENDERER-EXEMPT` on the
  // preceding line works even when the banned call is nested inside a
  // VariableDeclaration or ExpressionStatement.
  let target = node;
  while (
    target.parent &&
    target.parent.type !== "Program" &&
    !/Statement$|Declaration$/.test(target.parent.type)
  ) {
    target = target.parent;
  }
  if (target.parent && /Statement$|Declaration$/.test(target.parent.type)) {
    target = target.parent;
  }
  const before = src.getCommentsBefore(target);
  return before.some((c) => /RENDERER-EXEMPT/.test(c.value));
}

function isXlsxMember(node, banned) {
  return (
    node.type === "MemberExpression" &&
    node.property &&
    node.property.type === "Identifier" &&
    banned.has(node.property.name)
  );
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid xlsx write-side APIs in app code; generate XLSX server-side via render-report (Milestone C.2).",
    },
    schema: [],
    messages: {
      banned:
        "xlsx write APIs are forbidden in app code (Milestone C.2). Route through supabase.functions.invoke('render-report', { body: { format: 'xlsx' } }) so the workbook matches the PDF path.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (hasExempt(context, node)) return;
        const callee = node.callee;
        // XLSX.write(...) / XLSX.writeFile(...)
        if (isXlsxMember(callee, BANNED_MEMBERS)) {
          context.report({ node, messageId: "banned" });
          return;
        }
        // XLSX.utils.book_new() / XLSX.utils.aoa_to_sheet() / ...
        if (
          callee.type === "MemberExpression" &&
          callee.object &&
          callee.object.type === "MemberExpression" &&
          callee.object.property &&
          callee.object.property.name === "utils" &&
          isXlsxMember(callee, BANNED_UTIL_MEMBERS)
        ) {
          context.report({ node, messageId: "banned" });
        }
      },
    };
  },
};
