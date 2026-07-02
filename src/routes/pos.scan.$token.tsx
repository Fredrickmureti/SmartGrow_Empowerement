/**
 * Legacy TanStack route — `/pos/scan/:token` QRs minted before the
 * 2026-06 audit (when the scanner pairing route lived under `/pos/*`).
 * The canonical route is now `/scan/:token` (see ADR 0017 / scan.$token.tsx).
 * Redirect verbatim so old QRs keep working without going through the POS
 * subscription gate.
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/pos/scan/$token")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: `/scan/${params.token}`, replace: true });
  },
});
