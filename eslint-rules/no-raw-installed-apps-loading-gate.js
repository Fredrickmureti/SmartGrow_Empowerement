/**
 * no-raw-installed-apps-loading-gate
 *
 * Forbids destructuring `isLoading` from `useInstalledApps()` outside of
 * the canonical readiness modules. The architectural rule (see
 * .lovable/plan.md → "Workspace install-state hydration") is that any
 * surface gating UI on install state MUST consume
 * `useWorkspaceContextReady({ appId })`. `useInstalledApps().isLoading`
 * is `false` while React Query still has zero authoritative rows, which
 * is exactly the hydration race we just closed.
 *
 * Decoration-only spinner sites (e.g. an inline skeleton inside a card)
 * may opt out with an inline
 * `// eslint-disable-next-line local/no-raw-installed-apps-loading-gate`
 * comment plus a one-line justification.
 */

const ALLOWLIST = new Set([
  "src/hooks/useInstalledApps.ts",
  "src/hooks/useWorkspaceContextReady.ts",
  "src/components/apps/InstalledAppsHydration.tsx",
]);

function normalize(filename) {
  return filename.replace(/\\/g, "/");
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Do not gate UI on useInstalledApps().isLoading — use useWorkspaceContextReady() instead.",
    },
    schema: [],
    messages: {
      forbidden:
        "Do not destructure `isLoading` from useInstalledApps(). Gate install-aware UI on `useWorkspaceContextReady({ appId })`. If this is a decoration-only spinner, add an inline disable comment with a justification.",
    },
  },
  create(context) {
    const filename = normalize(context.getFilename());
    if ([...ALLOWLIST].some((p) => filename.endsWith(p))) {
      return {};
    }
    return {
      VariableDeclarator(node) {
        // Pattern:  const { isLoading, ... } = useInstalledApps()
        if (
          node.id?.type !== "ObjectPattern" ||
          node.init?.type !== "CallExpression" ||
          node.init.callee?.type !== "Identifier" ||
          node.init.callee.name !== "useInstalledApps"
        ) {
          return;
        }
        for (const prop of node.id.properties) {
          if (
            prop.type === "Property" &&
            prop.key?.type === "Identifier" &&
            prop.key.name === "isLoading"
          ) {
            context.report({ node: prop, messageId: "forbidden" });
          }
        }
      },
    };
  },
};
