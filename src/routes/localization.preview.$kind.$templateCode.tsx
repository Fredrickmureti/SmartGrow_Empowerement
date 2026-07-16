/**
 * Pop-out preview window for the Localization Editor authoring workspace.
 *
 * Opened by CertificateTemplateEditor / ReturnTemplateEditor via
 * `AuthoringWorkspace.onPopOutPreview`. The opener continuously
 * broadcasts its live draft (body + meta + template code) on a
 * BroadcastChannel and mirrors it to `localStorage` as a fallback for
 * the initial paint. This child window subscribes and re-renders the
 * same preview pane component publishers already see in the split
 * layout — so detaching onto a second monitor produces identical
 * output with zero server round trip.
 *
 * Route is intentionally client-only: no loader, no auth, no SSR. It
 * reads state the same origin's opener just wrote in the current
 * browser session.
 */
import { ClientOnly, createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const LocalizationPreviewWindow = lazy(
  () => import("@/features/localization/components/LocalizationPreviewWindow"),
);

export const Route = createFileRoute("/localization/preview/$kind/$templateCode")({
  head: () => ({
    meta: [
      { title: "Localization preview" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: PreviewRoute,
});

function PreviewRoute() {
  const { kind, templateCode } = Route.useParams();
  return (
    <ClientOnly fallback={<div style={{ padding: 24, fontFamily: "system-ui" }}>Loading preview…</div>}>
      <Suspense fallback={<div style={{ padding: 24, fontFamily: "system-ui" }}>Loading preview…</div>}>
        <LocalizationPreviewWindow kind={kind} templateCode={templateCode} />
      </Suspense>
    </ClientOnly>
  );
}