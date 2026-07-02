/**
 * HardwareExecContextMount — wires the active org/business into the
 * `HardwareExecLog` module-level context so every `hardwareClient.exec`
 * call writes a tenant-scoped row into `hardware_exec_log`.
 *
 * Without this mount, `setHardwareExecContext` is never called, `orgId`
 * stays `null`, and `recordHardwareExec` short-circuits before the
 * Supabase insert — the audit table stays empty forever even though the
 * in-memory ring buffer fills.
 *
 * No UI. Mount once near the app root inside the BusinessProvider.
 */
import { useEffect } from 'react';
import { useOrganization } from '@/hooks/useOrganization';
import { useBusinesses } from '@/hooks/useBusinesses';
import { setHardwareExecContext } from '@/services/hardware/HardwareExecLog';

export function HardwareExecContextMount() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  useEffect(() => {
    setHardwareExecContext({
      orgId: currentOrg?.id ?? null,
      businessId: currentBusiness?.id ?? null,
    });
    // Clear context on unmount / sign-out so a subsequent user-switch can't
    // briefly stamp the previous tenant's orgId onto a new actor's
    // hardware_exec_log rows. RLS would still block reads cross-tenant,
    // but the writer should never assert a stale identity.
    return () => {
      setHardwareExecContext({ orgId: null, businessId: null });
    };
  }, [currentOrg?.id, currentBusiness?.id]);

  return null;
}

export default HardwareExecContextMount;
