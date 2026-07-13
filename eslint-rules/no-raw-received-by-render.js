/**
 * ESLint rule: no-raw-received-by-render
 *
 * Forbids JSX expressions that render `*.received_by` directly. The column
 * may carry a UUID (goods_receipts) or legacy free-text that happens to be a
 * UUID (delivery_notes), and rendering it raw is exactly the leak that hit
 * the Logistics card ("Received by: 87b86b09-…").
 *
 * Pass the value through `resolveRecipientName` /
 * `resolveGoodsReceiptRecipient` from `@/lib/recipientName` instead.
 *
 * Allowed locations:
 *   - src/lib/recipientName.ts            (the resolver itself)
 *   - src/lib/looksLikeUUID.ts            (back-compat shim)
 *   - __tests__ and test/ directories    (fixtures may construct raw objects)
 */

const ALLOW_PATH_FRAGMENTS = [
  "src/lib/recipientName",
  "src/lib/looksLikeUUID",
  "/test/",
  "/__tests__/",
];

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow rendering raw .received_by — go through resolveRecipientName / resolveGoodsReceiptRecipient.",
    },
    schema: [],
    messages: {
      raw: "Do not render `.received_by` directly — use resolveRecipientName / resolveGoodsReceiptRecipient from @/lib/recipientName.",
    },
  },
  create(context) {
    const filename = context.getFilename().replace(/\\/g, "/");
    if (ALLOW_PATH_FRAGMENTS.some((f) => filename.includes(f))) {
      return {};
    }
    return {
      JSXExpressionContainer(node) {
        const expr = node.expression;
        // Match {x.received_by} and {x?.received_by}
        const isMember =
          expr &&
          (expr.type === "MemberExpression" ||
            expr.type === "ChainExpression");
        const inner =
          expr && expr.type === "ChainExpression" ? expr.expression : expr;
        if (
          isMember &&
          inner &&
          inner.type === "MemberExpression" &&
          inner.property &&
          inner.property.type === "Identifier" &&
          inner.property.name === "received_by"
        ) {
          context.report({ node, messageId: "raw" });
        }
      },
    };
  },
};