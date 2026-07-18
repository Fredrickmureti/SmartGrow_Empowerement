/**
 * no-pos-commit-without-idempotency-key
 *
 * ADR 0082 · Batch T2. Every call to `supabase.rpc("process_pos_transaction", ...)`
 * MUST pass a `p_idempotency_key` — the database trigger
 * `trg_pos_transactions_require_idempotency_key` rejects inserts without one,
 * and the previous `|| crypto.randomUUID()` fallback silently defeated
 * retry-collapse.
 *
 * Detects the two forms we ship:
 *   supabase.rpc("process_pos_transaction", { ...payload })
 *   supabase.rpc("process_pos_transaction" as any, { ... })
 *
 * and reports if `p_idempotency_key` is absent from the payload object,
 * OR is a `||`/`??` fallback to `crypto.randomUUID()` / `uuid()`.
 */

function isProcessPosTransactionCall(node) {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee;
  if (
    callee.type !== "MemberExpression" ||
    callee.property.type !== "Identifier" ||
    callee.property.name !== "rpc"
  ) {
    return false;
  }
  const first = node.arguments[0];
  if (!first) return false;
  // "process_pos_transaction" or "process_pos_transaction" as any
  const strNode =
    first.type === "TSAsExpression" ? first.expression : first;
  return (
    strNode.type === "Literal" &&
    typeof strNode.value === "string" &&
    strNode.value === "process_pos_transaction"
  );
}

function hasSafeIdempotencyKey(payloadNode) {
  if (!payloadNode || payloadNode.type !== "ObjectExpression") return false;
  const prop = payloadNode.properties.find(
    (p) =>
      p.type === "Property" &&
      p.key &&
      ((p.key.type === "Identifier" && p.key.name === "p_idempotency_key") ||
        (p.key.type === "Literal" && p.key.value === "p_idempotency_key")),
  );
  if (!prop) return { ok: false, reason: "missing" };

  // Reject `x || crypto.randomUUID()` / `x ?? crypto.randomUUID()` shapes.
  const val = prop.value;
  if (val.type === "LogicalExpression" && (val.operator === "||" || val.operator === "??")) {
    const right = val.right;
    if (
      right.type === "CallExpression" &&
      right.callee.type === "MemberExpression" &&
      right.callee.property.type === "Identifier" &&
      (right.callee.property.name === "randomUUID" ||
        right.callee.property.name === "uuid")
    ) {
      return { ok: false, reason: "fallback" };
    }
  }
  return { ok: true };
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "process_pos_transaction RPC calls must pass a deterministic p_idempotency_key (ADR 0082 · T2). No `|| crypto.randomUUID()` fallbacks.",
    },
    schema: [],
    messages: {
      missing:
        "process_pos_transaction call is missing p_idempotency_key. Resolve one via useCommitKey(register, shift) or use the queued.id from TransactionQueue (ADR 0082 · Batch T2).",
      fallback:
        "process_pos_transaction call falls back to crypto.randomUUID() when p_idempotency_key is missing. Fallbacks defeat retry-collapse — throw at the boundary instead (ADR 0082 · Batch T2).",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        if (!isProcessPosTransactionCall(node)) return;
        const payload = node.arguments[1];
        const check = hasSafeIdempotencyKey(payload);
        if (check === false || (check && check.ok === false)) {
          context.report({ node, messageId: check.reason || "missing" });
        }
      },
    };
  },
};
