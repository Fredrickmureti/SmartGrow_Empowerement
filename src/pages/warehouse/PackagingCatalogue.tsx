/**
 * Warehouse → Packaging catalogue (ADR 0105, Phases 7–8).
 *
 * Thin page shell. The legacy `CartonTypes` page and its catalogue table are
 * decommissioned; the packaging master is the only catalogue and every write
 * is server-owned.
 */

import PackagingMasterWorkspace from "@/features/warehouse/packaging/workspace/PackagingMasterWorkspace";

export default function PackagingCatalogue() {
  return <PackagingMasterWorkspace />;
}
