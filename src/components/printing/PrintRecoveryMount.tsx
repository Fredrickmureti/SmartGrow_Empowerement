/**
 * PrintRecoveryMount — starts the print-job recovery sweeper once, for the
 * active business.
 *
 * The sweeper reclaims print jobs stranded by a crashed or closed session.
 * It used to be started by <BusinessSagaMount />, which was removed with the
 * hardware/POS surface; this mount keeps recovery alive without reviving any
 * of that. `startPrintRecoverySweeper` is idempotent — a second call replaces
 * the first — so remounts cannot stack timers.
 */
import { useEffect } from "react";
import { useBusinesses } from "@/hooks/useBusinesses";
import { startPrintRecoverySweeper } from "@/services/printing/recovery";

export function PrintRecoveryMount() {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;

  useEffect(() => {
    if (!businessId) return;
    return startPrintRecoverySweeper(businessId);
  }, [businessId]);

  return null;
}

export default PrintRecoveryMount;
