/**
 * ElectronHydratorMount — mount once near the app root to keep the Electron
 * SQLite device cache in sync with the Supabase `device_assignments` table.
 *
 * Audit Wave 9d.5: now scope-aware. Hydrates only assignments for the
 * active `(organization_id, business_id)` and pushes the active terminal
 * id to the main process so register-scoped rows resolve correctly.
 *
 * No-ops when not running inside Electron. No UI.
 */
import { useEffect } from 'react';
import { useOrganization } from '@/hooks/useOrganization';
import { useBusinesses } from '@/hooks/useBusinesses';
import {
  startElectronAssignmentHydrator,
  stopElectronAssignmentHydrator,
} from '@/services/hardware/ElectronAssignmentHydrator';
import { hardwareClient } from '@/services/hardware';

/**
 * Wave 11 R5: terminal id is a required invariant. Auto-generate a stable
 * per-install UUID on first boot so existing installs aren't broken, but
 * never fall back to the legacy `"default"` literal that collided across
 * unrelated terminals.
 */
function readOrCreateActiveTerminalId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const existing = window.localStorage.getItem('pos:activeTerminalId');
    if (existing && existing.trim().length > 0) return existing;
    const generated =
      (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
        ? `terminal-${crypto.randomUUID()}`
        : `terminal-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem('pos:activeTerminalId', generated);
    return generated;
  } catch {
    return null;
  }
}


export function ElectronHydratorMount() {
  const { currentOrg } = useOrganization();
  // useBusinesses may not be initialised on first render; tolerate undefined.
  let businessId: string | null = null;
  try {
    const { currentBusiness } = useBusinesses();
    businessId = currentBusiness?.id ?? null;
  } catch {
    businessId = null;
  }
  const orgId = currentOrg?.id;

  useEffect(() => {
    if (!orgId) return;
    const terminalId = readOrCreateActiveTerminalId();
    const stop = startElectronAssignmentHydrator({
      orgId,
      businessId,
      terminalId,
    });
    void hardwareClient.customerDisplay.rebindIfElectronWindowOpen();
    return () => {
      stop();
      stopElectronAssignmentHydrator();
    };
  }, [orgId, businessId]);

  return null;
}

export default ElectronHydratorMount;
