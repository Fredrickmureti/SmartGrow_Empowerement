/**
 * Warehouse → Packaging catalogue (ADR 0105, Phase 7).
 *
 * Thin page shell. The legacy `CartonTypes` page (direct CRUD on
 * `wms_carton_types`) is retired; the packaging master is the only
 * catalogue and every write is server-owned.
 */
import PackagingMasterWorkspace from "@/features/warehouse/packaging/workspace/PackagingMasterWorkspace";

export default function PackagingCatalogue() {
  return <PackagingMasterWorkspace />;
}
