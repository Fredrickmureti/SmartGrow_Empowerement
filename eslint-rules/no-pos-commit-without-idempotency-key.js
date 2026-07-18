/**
 * no-pos-commit-without-idempotency-key
 *
 * ADR 0082 · Batch T2 + Wave 3 · Phase 1. Every call to the POS commit
 * RPCs and the payment-session mutation RPCs MUST pass a
 * `p_idempotency_key` — the underlying triggers and RPC guards reject
 * inserts without one, and a `|| crypto.randomUUID()` fallback silently
 * defeats retry-collapse.
 *
 * Covered RPCs (all require `p_idempotency_key`):
 *   - process_pos_transaction               (ADR 0082 · T2)
 *   - pos_payment_session_open              (Wave 3 · P1)
 *   - pos_payment_session_record_tender     (Wave 3 · P1)
 */

const GUARDED_RPCS = new Set([
  "process_pos_transaction",
  "pos_payment_session_open",
  "pos_payment_session_record_tender",
]);

function isGuardedRpcCall(node) {
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
  const strNode = first.type === "TSAsExpression" ? first.expression : first;
  return (
    strNode.type === "Literal" &&
    typeof strNode.value === "string" &&
    GUARDED_RPCS.has(strNode.value)
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
        if (!isGuardedRpcCall(node)) return;
        const payload = node.arguments[1];
        const check = hasSafeIdempotencyKey(payload);
        if (check === false || (check && check.ok === false)) {
          context.report({ node, messageId: check.reason || "missing" });
        }
      },
    };
  },
};
