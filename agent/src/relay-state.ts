/**
 * Shared, in-process relay health state.
 *
 * The relay loop is the only thing that knows whether this workstation's
 * credential is actually accepted by AccrualFlow. Both `/status` (browser
 * pairing UI) and the desktop shell need that answer, so the loop publishes
 * it here instead of each surface guessing from `workstation.json` existing.
 */

export type RelayState = 'inactive' | 'starting' | 'ok' | 'unauthorized' | 'error';

export interface RelayHealth {
  state: RelayState;
  workstationId: string | null;
  /** ISO timestamp of the last poll that the server accepted. */
  lastPollOkAt: string | null;
  lastError: string | null;
  consecutiveErrors: number;
  /** How many times the credential was hot-reloaded from disk. */
  credentialReloads: number;
}

let health: RelayHealth = {
  state: 'inactive',
  workstationId: null,
  lastPollOkAt: null,
  lastError: null,
  consecutiveErrors: 0,
  credentialReloads: 0,
};

export function getRelayHealth(): RelayHealth {
  return { ...health };
}

export function setRelayHealth(patch: Partial<RelayHealth>): void {
  health = { ...health, ...patch };
}
