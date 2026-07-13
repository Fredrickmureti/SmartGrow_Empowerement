/**
 * ESLint rule: forbid raw `<iframe>` elements rendering PDF blob URLs or
 * arbitrary PDF/document URLs outside the canonical viewers.
 *
 * Background (ADR-0015): every PDF preview must funnel through
 * `SafePdfViewer`, and every legacy HTML preview through `SafeHtmlPreview`.
 * Raw `<iframe src={blob:…}>` or `<iframe src={previewUrl}>` patterns
 * silently break in Electron under `file://` with no recovery affordance,
 * which is the exact bug ADR-0015 was opened to fix.
 *
 * The rule flags `<iframe>` JSX where:
 *   - `src` is a `URL.createObjectURL(...)` call,
 *   - `src` is an identifier/member whose name contains `blob`, `pdf`,
 *     `preview`, `signed`, or `document`,
 *   - `srcDoc` is used outside the canonical HTML viewer.
 *
 * Allowlisted files:
 *   - src/components/common/SafePdfViewer.tsx
 *   - src/components/common/SafeHtmlPreview.tsx
 *
 * Bypass with a line-level `// eslint-disable-next-line
 * local/no-direct-pdf-iframe -- <reason>` only when there is a real reason
 * (e.g. a vendored editor preview that owns its own lifecycle).
 */

const ALLOWLIST = [
  '/src/components/common/SafePdfViewer.tsx',
  '/src/components/common/SafeHtmlPreview.tsx',
];

const SUSPICIOUS_NAME = /(blob|pdf|preview|signed|document|file)/i;

function isAllowlistedFile(filename) {
  return ALLOWLIST.some((p) => filename.endsWith(p));
}

function isCreateObjectUrlCall(node) {
  if (!node || node.type !== 'CallExpression') return false;
  const callee = node.callee;
  if (!callee || callee.type !== 'MemberExpression') return false;
  return (
    callee.object && callee.object.name === 'URL' &&
    callee.property && callee.property.name === 'createObjectURL'
  );
}

function nameSuggestsPdf(node) {
  if (!node) return false;
  if (node.type === 'Identifier' && SUSPICIOUS_NAME.test(node.name)) return true;
  if (node.type === 'MemberExpression') {
    if (node.property && node.property.name && SUSPICIOUS_NAME.test(node.property.name)) return true;
    return nameSuggestsPdf(node.object);
  }
  return false;
}

function literalLooksLikePdfUrl(node) {
  if (!node) return false;
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return /^blob:/i.test(node.value) || /\.pdf(\?|$)/i.test(node.value);
  }
  if (node.type === 'TemplateLiteral' && node.quasis && node.quasis[0]) {
    const raw = node.quasis[0].value && node.quasis[0].value.raw;
    if (typeof raw === 'string' && (/^blob:/i.test(raw) || /\.pdf(\?|$)/i.test(raw))) return true;
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Forbid raw <iframe> elements for PDF/preview rendering. Use SafePdfViewer or SafeHtmlPreview.',
    },
    schema: [],
    messages: {
      rawPdfIframe:
        'Raw <iframe> rendering a PDF/preview source ({{ reason }}). Use <SafePdfViewer pdfBlob={…}/> or <SafePdfViewer pdfUrl={…}/> (ADR-0015). HTML previews must use <SafeHtmlPreview/>.',
    },
  },
  create(context) {
    const filename = context.getFilename();
    if (!filename.includes('/src/')) return {};
    if (isAllowlistedFile(filename)) return {};

    return {
      JSXOpeningElement(node) {
        if (!node.name || node.name.type !== 'JSXIdentifier' || node.name.name !== 'iframe') return;

        for (const attr of node.attributes || []) {
          if (attr.type !== 'JSXAttribute') continue;
          const attrName = attr.name && attr.name.name;
          if (attrName !== 'src' && attrName !== 'srcDoc') continue;

          // srcDoc outside the canonical HTML viewer is suspect.
          if (attrName === 'srcDoc') {
            context.report({
              node: attr,
              messageId: 'rawPdfIframe',
              data: { reason: 'srcDoc bypasses SafeHtmlPreview' },
            });
            continue;
          }

          // src={…}
          const value = attr.value;
          if (!value) continue;
          if (value.type === 'Literal') {
            if (literalLooksLikePdfUrl(value)) {
              context.report({ node: attr, messageId: 'rawPdfIframe', data: { reason: 'string source looks like a PDF/blob URL' } });
            }
            continue;
          }
          if (value.type !== 'JSXExpressionContainer') continue;
          const expr = value.expression;
          if (isCreateObjectUrlCall(expr)) {
            context.report({ node: attr, messageId: 'rawPdfIframe', data: { reason: 'URL.createObjectURL(...)' } });
            continue;
          }
          if (literalLooksLikePdfUrl(expr)) {
            context.report({ node: attr, messageId: 'rawPdfIframe', data: { reason: 'string source looks like a PDF/blob URL' } });
            continue;
          }
          if (nameSuggestsPdf(expr)) {
            context.report({ node: attr, messageId: 'rawPdfIframe', data: { reason: 'identifier name suggests a PDF/preview source' } });
          }
        }
      },
    };
  },
};
