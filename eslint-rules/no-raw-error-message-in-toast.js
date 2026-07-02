/**
 * no-raw-error-message-in-toast
 *
 * Bans patterns that surface raw `error.message` (or similarly raw
 * server text) directly to users via toast/sonner. Forces callers to
 * route through `normalizeError(...)` from `@/services/resilience`.
 *
 * Flags:
 *   toast.error(err.message)
 *   toast.error(`Failed: ${err.message}`)
 *   toast({ description: err.message })
 *   sonnerToast.error(error.message)
 *
 * Skips (intentionally narrow scope to avoid false positives):
 *   - string literals not interpolating an error
 *   - console.* calls
 *   - test files (`**__tests__**`, `*.test.ts(x)`, `src/test/**`)
 */
"use strict";

function isErrorMessageNode(node) {
  if (!node) return false;
  if (node.type === "MemberExpression") {
    const prop = node.property;
    if (prop && (prop.name === "message" || (prop.type === "Literal" && prop.value === "message"))) {
      const obj = node.object;
      if (obj && obj.type === "Identifier") {
        const n = obj.name.toLowerCase();
        return n === "error" || n === "err" || n === "e" || n.endsWith("error");
      }
    }
  }
  if (node.type === "TemplateLiteral") {
    return node.expressions.some(isErrorMessageNode);
  }
  if (node.type === "LogicalExpression" || node.type === "BinaryExpression") {
    return isErrorMessageNode(node.left) || isErrorMessageNode(node.right);
  }
  return false;
}

function getToastCalleeName(node) {
  // toast.error(...) / sonner.toast.error(...) / sonner-style
  if (node.type === "MemberExpression") {
    const propName = node.property && (node.property.name || node.property.value);
    const objectName = node.object && node.object.type === "Identifier" ? node.object.name : null;
    if (objectName && /toast|sonner/i.test(objectName)) return `${objectName}.${propName}`;
  }
  // toast(...) bare call
  if (node.type === "Identifier" && /^toast$/i.test(node.name)) return node.name;
  return null;
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow surfacing raw error.message (or similar) inside toast/sonner calls; use normalizeError() from @/services/resilience.",
    },
    schema: [],
    messages: {
      raw: "Do not pass raw error.message to toast — wrap it with normalizeError() from @/services/resilience so users see a human-readable, action-oriented message.",
    },
  },
  create(context) {
    const filename = context.getFilename();
    if (/[\\/](test|__tests__)[\\/]/.test(filename) || /\.test\.[tj]sx?$/.test(filename)) {
      return {};
    }
    return {
      CallExpression(node) {
        const calleeName = getToastCalleeName(node.callee);
        if (!calleeName) return;
        for (const arg of node.arguments) {
          if (isErrorMessageNode(arg)) {
            context.report({ node: arg, messageId: "raw" });
            return;
          }
          if (arg.type === "ObjectExpression") {
            for (const prop of arg.properties) {
              if (prop.type !== "Property") continue;
              const keyName = prop.key && (prop.key.name || prop.key.value);
              if ((keyName === "description" || keyName === "title") && isErrorMessageNode(prop.value)) {
                context.report({ node: prop.value, messageId: "raw" });
                return;
              }
            }
          }
        }
      },
    };
  },
};
