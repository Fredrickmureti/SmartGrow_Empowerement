/**
 * Guards the Wave-9f fix: inside Electron, an incomplete or missing
 * `window.pos.app.customerDisplay` bridge must NEVER fall through to a
 * browser `window.open()` (which then surfaces a misleading
 * "Pop-up blocked" toast). The renderer must instead return a typed
 * `electron_preload_stale` / `electron_preload_failed` reason.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { customerDisplayClient } from '@/services/hardware/local-display/CustomerDisplayClient';

function resetClient() {
  (customerDisplayClient as unknown as { isConnected: boolean }).isConnected = false;
  (customerDisplayClient as unknown as { displayWindow: Window | null }).displayWindow = null;
}

describe('CustomerDisplayClient — Electron environment guard', () => {
  const origUA = navigator.userAgent;
  const origPos = (window as unknown as { pos?: unknown }).pos;

  beforeEach(() => { resetClient(); });
  afterEach(() => {
    Object.defineProperty(navigator, 'userAgent', { value: origUA, configurable: true });
    (window as unknown as { pos?: unknown }).pos = origPos;
  });

  it('returns electron_preload_stale and does NOT call window.open when bridge is partial', async () => {
    (window as unknown as { pos?: unknown }).pos = {
      isElectron: true,
      preloadBuild: 'legacy-2026-05-01',
      // app.customerDisplay deliberately missing (stale preload)
    };
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    const res = await customerDisplayClient.open({ enabled: true });

    expect(res.success).toBe(false);
    expect(res.reason).toBe('electron_preload_stale');
    expect(res.error ?? '').toMatch(/out of date|preloadBuild/i);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('returns electron_preload_failed when UA says Electron but window.pos is absent', async () => {
    (window as unknown as { pos?: unknown }).pos = undefined;
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (X11; Linux x86_64) Electron/30.0.0 Chrome/124.0.0.0',
      configurable: true,
    });
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    const res = await customerDisplayClient.open({ enabled: true });

    expect(res.success).toBe(false);
    expect(res.reason).toBe('electron_preload_failed');
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('uses browser popup path with browser_popup_blocked reason when truly in a browser', async () => {
    (window as unknown as { pos?: unknown }).pos = undefined;
    Object.defineProperty(navigator, 'userAgent', {
      value: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/124.0.0.0',
      configurable: true,
    });
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    const res = await customerDisplayClient.open({ enabled: true });

    expect(openSpy).toHaveBeenCalledOnce();
    expect(res.success).toBe(false);
    expect(res.reason).toBe('browser_popup_blocked');
  });
});