/**
 * ESLint rule: no-hand-rolled-address-format
 *
 * There is exactly ONE address formatter in this platform. Concatenating
 * `address_line1 + city + postal_code` by hand in a feature module, a
 * document snapshot builder or a PDF path is how printed addresses drift
 * apart: one surface prints the state, another drops it, a third prints the
 * country twice. See ADR-0080.
 *
 * Use instead:
 *   - `formatAddress` from `@/lib/contactAddresses` (counterparty addresses)
 *   - `formatPartyAddress` / `resolveSnapshotAddress` from
 *     `src/services/documents/snapshots/partyAddress` (snapshot builders)
 *   - `formatInternalDestination` from `@/lib/internalDestinations`
 *     (our own warehouses / branches)
 *
 * The rule fires when an address field (`address_line1` / `address_line2`)
 * and a locality field (`city` / `state` / `postal_code`) are combined in
 * the same array literal, template literal or `+` chain.
 *
 * Allowed locations: the canonical formatters themselves, tests, and the
 * edge-function shared renderer which cannot import from `src/`.
 */

const ALLOW_PATH_FRAGMENTS = [
  "src/lib/contactAddresses",
  "src/lib/internalDestinations",
  "src/services/documents/snapshots/partyAddress",
  "supabase/functions/_shared/",
  "/test/",
  "/tests/",
  "/__tests__/",
];

const ADDRESS_FIELDS = ["address_line1", "address_line2"];
const LOCALITY_FIELDS = ["city", "state", "postal_code"];

/** Nodes that represent "these values are being glued together". */
const COMBINING_TYPES = new Set([
  "ArrayExpression",
  "TemplateLiteral",
  "BinaryExpression",
]);

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow hand-rolled address string building — use formatAddress / formatPartyAddress / formatInternalDestination.",
    },
    schema: [],
    messages: {
      handRolled:
        "Do not hand-roll address formatting. Use formatAddress from @/lib/contactAddresses (or formatPartyAddress in snapshot builders, formatInternalDestination for our own locations). See ADR-0080.",
    },
  },
  create(context) {
    const filename = context.getFilename().replace(/\\/g, "/");
    if (ALLOW_PATH_FRAGMENTS.some((f) => filename.includes(f))) return {};

    const sourceCode = context.getSourceCode
      ? context.getSourceCode()
      : context.sourceCode;
    const reported = new WeakSet();

    return {
      MemberExpression(node) {
        const prop = node.property;
        if (
          node.computed ||
          !prop ||
          prop.type !== "Identifier" ||
          !ADDRESS_FIELDS.includes(prop.name)
        ) {
          return;
        }

        // Walk up to the nearest combining expression.
        let current = node.parent;
        let combining = null;
        while (current && !combining) {
          if (COMBINING_TYPES.has(current.type)) combining = current;
          else if (
            current.type === "ChainExpression" ||
            current.type === "MemberExpression" ||
            current.type === "LogicalExpression" ||
            current.type === "ConditionalExpression" ||
            current.type === "CallExpression"
          ) {
            current = current.parent;
          } else break;
        }
        if (!combining || reported.has(combining)) return;
        if (combining.type === "BinaryExpression" && combining.operator !== "+")
          return;

        const text = sourceCode.getText(combining);
        if (!LOCALITY_FIELDS.some((f) => text.includes(f))) return;

        reported.add(combining);
        context.report({ node: combining, messageId: "handRolled" });
      },
    };
  },
};
