/**
 * ESLint rule: no-country-fixture-in-shared-preview
 *
 * ADR 0063: shared localization preview code
 * (`src/features/localization/components/preview/**`,
 * `src/features/localization/lib/preview/**`) must stay country-
 * agnostic. A publisher previewing a Ghana pack must not see Kenya
 * PINs — the fixture library is
 * `src/features/localization/lib/preview/samplePayload.ts` and any
 * country-specific sample belongs in `pack_token_registry.sample_value`
 * keyed by pack_id.
 *
 * This rule bans imports that match `<countrycode>*Fixture` from
 * `../lib/fixtures/**` under those directories. Opt-out per-line:
 * `// LOCALIZATION-EXEMPT: <reason>`.
 */

const COUNTRY_PREFIX_RE = /(?:^|\/)(?:ke|ug|tz|rw|za|ng|gh)[A-Z0-9][A-Za-z0-9]*(?:Fixture|Payload)/;

function hasExempt(context, node) {
  const src = context.getSourceCode();
  const before = src.getCommentsBefore(node);
  return before.some((c) => /LOCALIZATION-EXEMPT/.test(c.value));
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Forbid country-prefixed fixture imports from shared localization preview code.",
    },
    schema: [],
    messages: {
      banned:
        'Country-specific fixture ("{{name}}") is forbidden in shared localization preview code (ADR 0063). Use samplePayload.ts or pack_token_registry.sample_value.',
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        const src = node.source && node.source.value;
        if (typeof src !== "string") return;
        if (COUNTRY_PREFIX_RE.test(src)) {
          if (!hasExempt(context, node)) {
            context.report({ node, messageId: "banned", data: { name: src } });
          }
          return;
        }
        // Also catch named imports of country-prefixed identifiers.
        for (const spec of node.specifiers ?? []) {
          const imported =
            spec.type === "ImportSpecifier"
              ? (spec.imported && spec.imported.name) || spec.local.name
              : spec.local.name;
          if (typeof imported === "string" && /^(KE|UG|TZ|RW|ZA|NG|GH)_[A-Z0-9_]+_(PAYLOAD|FIXTURE)$/.test(imported)) {
            if (!hasExempt(context, node)) {
              context.report({ node, messageId: "banned", data: { name: imported } });
            }
          }
        }
      },
    };
  },
};