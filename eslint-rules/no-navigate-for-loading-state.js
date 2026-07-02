/**
 * ESLint rule: forbid `<Navigate to="/select-organization">` or
 * `navigate("/select-organization", …)` as control-flow for loading /
 * empty workspace state.
 *
 * Background (ADR-0034): the workspace picker URL is reserved for explicit
 * user intent (clicking "Switch workspace") and the one-shot post-login
 * destination resolver. Route guards that redirect to the picker to signal
 * "I haven't resolved your workspace yet" produce the
 * `/select-organization?returnTo=…` flash on reload that the architecture
 * audit removed. Empty/loading states must render in place via
 * <NoWorkspaceEmptyState/> or <BrandedLoader/> using the
 * `useWorkspaceRouting` selector.
 *
 * Allowlisted files (same set as the runtime arch test
 * src/test/architecture/no-redirect-to-picker.test.ts):
 *   - src/pages/SelectOrganization.tsx        (the picker page itself)
 *   - src/components/common/WorkspaceRecoveryCard.tsx   (explicit user click)
 *   - src/components/common/NoWorkspaceEmptyState.tsx   (explicit CTA)
 *   - src/lib/auth/flowRouter.ts              (post-login resolver)
 *   - src/lib/auth/postLoginRedirect.ts       (post-login resolver)
 */

const ALLOWLIST = [
  '/src/pages/SelectOrganization.tsx',
  '/src/components/common/WorkspaceRecoveryCard.tsx',
  '/src/components/common/NoWorkspaceEmptyState.tsx',
  '/src/lib/auth/flowRouter.ts',
  '/src/lib/auth/postLoginRedirect.ts',
];

const PICKER_PATH = '/select-organization';

function isAllowlistedFile(filename) {
  return ALLOWLIST.some((p) => filename.endsWith(p));
}

function literalIsPickerPath(node) {
  if (!node) return false;
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value === PICKER_PATH || node.value.startsWith(PICKER_PATH + '?');
  }
  if (node.type === 'TemplateLiteral' && node.quasis && node.quasis.length === 1) {
    const raw = node.quasis[0].value && node.quasis[0].value.cooked;
    if (typeof raw === 'string') {
      return raw === PICKER_PATH || raw.startsWith(PICKER_PATH + '?');
    }
  }
  return false;
}

/** Walks an object-literal `to: "/select-organization"` prop. */
function objectHasPickerTo(node) {
  if (!node || node.type !== 'ObjectExpression') return false;
  for (const prop of node.properties) {
    if (prop.type !== 'Property') continue;
    const keyName = prop.key && (prop.key.name || prop.key.value);
    if (keyName !== 'to') continue;
    if (literalIsPickerPath(prop.value)) return true;
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid <Navigate to="/select-organization"> and navigate("/select-organization") outside the allowlist. URL = user intent, not loading bookkeeping (ADR-0034).',
    },
    schema: [],
    messages: {
      noPickerRedirect:
        'Do not redirect to /select-organization as control flow. Render <NoWorkspaceEmptyState/> in place and gate via useWorkspaceRouting (ADR-0034).',
    },
  },
  create(context) {
    const filename = context.getFilename();
    if (!filename.includes('/src/')) return {};
    if (isAllowlistedFile(filename)) return {};

    return {
      // <Navigate to="/select-organization" ... />
      JSXOpeningElement(node) {
        if (!node.name || node.name.type !== 'JSXIdentifier') return;
        if (node.name.name !== 'Navigate') return;
        for (const attr of node.attributes || []) {
          if (attr.type !== 'JSXAttribute') continue;
          if (!attr.name || attr.name.name !== 'to') continue;
          const value = attr.value;
          if (!value) continue;
          if (value.type === 'Literal' && literalIsPickerPath(value)) {
            context.report({ node: attr, messageId: 'noPickerRedirect' });
            continue;
          }
          if (value.type === 'JSXExpressionContainer') {
            const expr = value.expression;
            if (literalIsPickerPath(expr)) {
              context.report({ node: attr, messageId: 'noPickerRedirect' });
            }
          }
        }
      },
      // navigate("/select-organization", ...) — react-router's useNavigate()
      // and TanStack's router.navigate({ to: "/select-organization" }).
      CallExpression(node) {
        const callee = node.callee;
        const calleeName =
          (callee && callee.type === 'Identifier' && callee.name) ||
          (callee && callee.type === 'MemberExpression' && callee.property && callee.property.name) ||
          null;
        if (calleeName !== 'navigate' && calleeName !== 'replace' && calleeName !== 'push') return;

        const firstArg = node.arguments[0];
        if (!firstArg) return;
        if (literalIsPickerPath(firstArg)) {
          context.report({ node: firstArg, messageId: 'noPickerRedirect' });
          return;
        }
        if (objectHasPickerTo(firstArg)) {
          context.report({ node: firstArg, messageId: 'noPickerRedirect' });
        }
      },
    };
  },
};
