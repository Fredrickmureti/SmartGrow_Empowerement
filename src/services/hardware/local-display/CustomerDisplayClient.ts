/**
 * CustomerDisplayClient — secondary-window orchestration for the
 * customer-facing display.
 *
 * Track H4 (ADR-0014). Formerly `CustomerDisplayService.ts`; moved here
 * so the public hardware surface in `HardwareClient.customerDisplay.*`
 * can wrap it without leaking the legacy name into hooks/components.
 *
 * In Electron the secondary screen is a real BrowserWindow driven via
 * `window.pos.app.customerDisplay.*` IPC. In the browser fallback a
 * popup window plus postMessage stands in for the same surface so the
 * POS preview works without Electron.
 */

export interface CustomerDisplayData {
  status: 'idle' | 'scanning' | 'payment' | 'complete';
  items: Array<{
    id: string;
    name: string;
    quantity: number;
    price: number;
    total: number;
  }>;
  subtotal: number;
  tax: number;
  discount: number;
  total: number;
  currency?: string;   // ISO 4217 code from org.base_currency
  locale?: string;     // e.g., "en-KE", "en-US"
  customerName?: string;
  loyaltyPoints?: number;
  message?: string;
}

export interface CustomerDisplayConfig {
  enabled: boolean;
  displayIndex?: number; // Which display to use (0 = primary, 1 = secondary, etc.)
  fullscreen?: boolean;
}

/**
 * Typed failure reasons. Lets the UI render reason-specific copy instead
 * of the historical single "Pop-up blocked" string that misled users
 * inside the packaged Electron app when the preload was stale.
 */
export type CustomerDisplayOpenReason =
  | 'ok'
  | 'browser_popup_blocked'
  | 'electron_preload_stale'
  | 'electron_preload_failed'
  | 'no_secondary_display'
  | 'unknown';

export interface CustomerDisplayOpenResult {
  success: boolean;
  error?: string;
  reason?: CustomerDisplayOpenReason;
}

const DEFAULT_IDLE: CustomerDisplayData = {
  status: 'idle', items: [], subtotal: 0, tax: 0, discount: 0, total: 0,
};

class CustomerDisplayClientImpl {
  private isConnected = false;
  private displayWindow: Window | null = null;
  private config: CustomerDisplayConfig = { enabled: false };
  /**
   * Last payload pushed via `update()`. Seeded with a default idle frame
   * so a popup that pings `request-state` BEFORE the cashier ever
   * mutates the cart still receives a valid payload (no blank-screen
   * race). Browser path only; Electron main pushes on every update.
   */
  private lastPayload: CustomerDisplayData = DEFAULT_IDLE;
  private requestStateBc: BroadcastChannel | null = null;


  /**
   * Check if customer display is available
   */
  isAvailable(): boolean {
    // Available in Electron with secondary display support
    if (this.isElectronEnvironment()) {
      return this.isElectronBridgeReady();
    }
    // In browser, we can use a popup window
    return true;
  }

  /**
   * Three-signal Electron detection. We treat the renderer as "inside
   * Electron" if ANY of these is true:
   *   - preload set `window.pos.isElectron = true` (canonical), OR
   *   - the user-agent contains ` Electron/` (Chromium signal that
   *     survives even when preload failed to load), OR
   *   - the `pos.app.customerDisplay.open` IPC binding is attached.
   *
   * This is deliberately broad so that a broken/stale preload cannot
   * masquerade as a regular browser and silently fall through to
   * `window.open()` — which would then be popup-blocked and surface a
   * misleading toast.
   */
  private isElectronEnvironment(): boolean {
    if (typeof window === 'undefined') return false;
    if (window.pos?.isElectron === true) return true;
    if (typeof navigator !== 'undefined' && / Electron\//.test(navigator.userAgent ?? '')) return true;
    if (typeof window.pos?.app?.customerDisplay?.open === 'function') return true;
    return false;
  }

  /**
   * The Electron path is only safe to take when ALL five
   * `customerDisplay` IPC bindings are attached. A stale packaged
   * binary or a preload-throw can leave a partial surface; in that
   * case the renderer must NOT degrade to a browser popup.
   */
  private isElectronBridgeReady(): boolean {
    const cd = window.pos?.app?.customerDisplay;
    return !!cd
      && typeof cd.open === 'function'
      && typeof cd.close === 'function'
      && typeof cd.update === 'function'
      && typeof cd.getDisplays === 'function'
      && typeof cd.isOpen === 'function';
  }

  /**
   * Get available displays
   */
  async getDisplays(): Promise<Array<{ id: number; label: string; primary: boolean }>> {
    if (this.isElectronEnvironment() && window.pos?.app?.customerDisplay?.getDisplays) {
      return window.pos!.app.customerDisplay.getDisplays();
    }
    
    // Browser fallback - return single "popup" display
    return [{ id: 0, label: 'Popup Window', primary: false }];
  }

  /**
   * Open the customer display on secondary screen
   */
  async open(config?: CustomerDisplayConfig): Promise<CustomerDisplayOpenResult> {
    if (config) {
      this.config = config;
    }

    try {
      const inElectron = this.isElectronEnvironment();

      // Electron context but the IPC surface is incomplete → stale
      // packaged build or a preload-throw. Never fall through to
      // `window.open()` inside Electron — that just produces a
      // misleading "Pop-up blocked" toast and hides the real cause.
      if (inElectron && !this.isElectronBridgeReady()) {
        const fp = (window.pos as unknown as { preloadBuild?: string } | undefined)?.preloadBuild;
        return {
          success: false,
          reason: window.pos ? 'electron_preload_stale' : 'electron_preload_failed',
          error: window.pos
            ? `Desktop app is out of date (preloadBuild=${fp ?? 'unknown'}). Reinstall the latest build to enable the customer display.`
            : 'Desktop preload failed to load. The customer display cannot start. Restart the desktop app; if the problem persists, check the application log.',
        };
      }

      if (inElectron && this.isElectronBridgeReady()) {
        // Pre-flight: clamp displayIndex into the available range so a
        // single-monitor workstation does not get dropped onto fullscreen
        // alwaysOnTop on the cashier's own screen. Main process also
        // clamps but doing it here lets us pass the right `fullscreen`
        // intent (no fullscreen when we know we'll land on primary).
        let resolvedIndex = config?.displayIndex ?? 1;
        let resolvedFullscreen = config?.fullscreen ?? true;
        let onlyOneDisplay = false;
        try {
          const displays = await this.getDisplays();
          if (displays.length > 0) {
            resolvedIndex = Math.max(0, Math.min(resolvedIndex, displays.length - 1));
            if (displays.length === 1) {
              resolvedFullscreen = false;
              onlyOneDisplay = true;
            }
          }
        } catch { /* fall through; main process will clamp */ }
        const result = await window.pos!.app.customerDisplay.open(
          resolvedIndex,
          resolvedFullscreen,
        );
        this.isConnected = result.success;
        return {
          ...result,
          reason: result.success ? 'ok' : (onlyOneDisplay ? 'no_secondary_display' : 'unknown'),
        };
      }

      // Browser fallback - open popup window. MUST be invoked from a
      // user gesture, and MUST happen synchronously before any `await`
      // — Chromium drops transient user activation after the first
      // microtask, which is why prior versions of this code were
      // popup-blocked even with permission granted.
      const displayUrl = `${window.location.origin}/pos/customer-display`;
      this.displayWindow = window.open(
        displayUrl,
        'CustomerDisplay',
        'width=1024,height=768,menubar=no,toolbar=no,location=no,status=no'
      );

      if (this.displayWindow) {
        this.isConnected = true;

        // Listen for "request-state" pings from the popup. The popup
        // sends one on mount; our listener replies with `lastPayload`
        // (seeded to a default idle frame), so there is no timer-based
        // race — the popup always paints something before the next
        // cart mutation.
        this.ensureRequestStateListener();

        // Handle window close
        const checkClosed = setInterval(() => {
          if (this.displayWindow?.closed) {
            this.isConnected = false;
            this.displayWindow = null;
            clearInterval(checkClosed);
          }
        }, 1000);

        return { success: true, reason: 'ok' };
      }


      return {
        success: false,
        reason: 'browser_popup_blocked',
        error:
          'Pop-up blocked. Allow pop-ups for this site to open the customer display.',
      };
    } catch (error) {
      return { success: false, reason: 'unknown', error: (error as Error).message };
    }
  }

  /**
   * Close the customer display
   */
  async close(): Promise<{ success: boolean; error?: string }> {
    try {
      if (this.isElectronEnvironment() && window.pos?.app?.customerDisplay?.close) {
        const result = await window.pos!.app.customerDisplay.close();
        this.isConnected = false;
        return result;
      }

      // Browser fallback
      if (this.displayWindow && !this.displayWindow.closed) {
        this.displayWindow.close();
      }
      this.displayWindow = null;
      this.isConnected = false;

      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Idempotently subscribe to "request-state" pings from popups that
   * reloaded themselves and need the last payload replayed. Same
   * BroadcastChannel as the update fan-out.
   */
  private ensureRequestStateListener(): void {
    if (this.requestStateBc) return;
    if (typeof BroadcastChannel === 'undefined') return;
    try {
      const bc = new BroadcastChannel('pos:customer-display');
      bc.onmessage = (ev: MessageEvent) => {
        if (ev.data?.type === 'customer-display-request-state') {
          // `lastPayload` is seeded to DEFAULT_IDLE so this is always safe.
          // Re-broadcast on a fresh channel so other contexts (the popup)
          // receive via the normal path, AND postMessage directly to the
          // opened window as a belt-and-braces for the case where the
          // popup attached its `message` listener before its
          // BroadcastChannel listener.
          try {
            const out = new BroadcastChannel('pos:customer-display');
            out.postMessage({ type: 'customer-display-update', payload: this.lastPayload });
            out.close();
          } catch { /* noop */ }
          try {
            if (this.displayWindow && !this.displayWindow.closed) {
              this.displayWindow.postMessage(
                { type: 'customer-display-update', payload: this.lastPayload },
                window.location.origin,
              );
            }
          } catch { /* noop */ }
        }
      };
      this.requestStateBc = bc;
    } catch { /* noop */ }
  }

  /**
   * Update the display with current transaction data
   */

  async update(data: CustomerDisplayData): Promise<{ success: boolean; error?: string }> {
    if (!this.isConnected) {
      return { success: false, error: 'Display not connected' };
    }
    this.lastPayload = data;


    try {
      if (this.isElectronEnvironment() && window.pos?.app?.customerDisplay?.update) {
        return window.pos!.app.customerDisplay.update(data);
      }

      // Browser fallback. Prefer BroadcastChannel so a reload of the popup
      // re-attaches without needing the opener's postMessage handle.
      try {
        if (typeof BroadcastChannel !== 'undefined') {
          const bc = new BroadcastChannel('pos:customer-display');
          bc.postMessage({ type: 'customer-display-update', payload: data });
          bc.close();
          // Also postMessage as a belt-and-braces for handlers attached on
          // the legacy channel.
          if (this.displayWindow && !this.displayWindow.closed) {
            this.displayWindow.postMessage(
              { type: 'customer-display-update', payload: data },
              window.location.origin,
            );
          }
          return { success: true };
        }
      } catch { /* fall through to postMessage path */ }
      if (this.displayWindow && !this.displayWindow.closed) {
        this.displayWindow.postMessage(
          { type: 'customer-display-update', payload: data },
          window.location.origin
        );
        return { success: true };
      }

      return { success: false, error: 'Display window not available' };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Show a custom message on the display
   */
  async showMessage(message: string, status?: 'idle' | 'scanning' | 'payment' | 'complete'): Promise<{ success: boolean; error?: string }> {
    return this.update({
      status: status || 'idle',
      items: [],
      subtotal: 0,
      tax: 0,
      discount: 0,
      total: 0,
      message,
    });
  }

  /**
   * Show thank you / completion message
   */
  async showComplete(total: number, customerName?: string): Promise<{ success: boolean; error?: string }> {
    return this.update({
      status: 'complete',
      items: [],
      subtotal: total,
      tax: 0,
      discount: 0,
      total,
      customerName,
      message: 'Thank you for your purchase!',
    });
  }

  /**
   * Reset display to idle state
   */
  async reset(): Promise<{ success: boolean; error?: string }> {
    return this.update({
      status: 'idle',
      items: [],
      subtotal: 0,
      tax: 0,
      discount: 0,
      total: 0,
    });
  }

  /**
   * Check if display is currently connected
   */
  isDisplayConnected(): boolean {
    if (this.isElectronEnvironment()) {
      return this.isConnected;
    }
    return this.displayWindow !== null && !this.displayWindow.closed;
  }

  /**
   * Get current configuration
   */
  getConfig(): CustomerDisplayConfig {
    return this.config;
  }

  /**
   * Rebind to a live Electron secondary window after a cashier-side
   * reload. Safe to call repeatedly; no-op outside Electron or when no
   * window is currently open. Hydrates the secondary screen with the
   * last known payload via the existing IPC `update` path.
   */
  async rebindIfElectronWindowOpen(): Promise<boolean> {
    if (!this.isElectronEnvironment() || !this.isElectronBridgeReady()) return false;
    try {
      const open = await window.pos!.app.customerDisplay.isOpen();
      if (!open) return false;
      this.isConnected = true;
      try { await window.pos!.app.customerDisplay.update(this.lastPayload); } catch { /* noop */ }
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Singleton customer-display orchestrator. Service-internal — UI code
 * MUST go through `hardwareClient.customerDisplay.*`. The
 * no-legacy-hardware-shell guard test enforces this rule.
 */
export const customerDisplayClient = new CustomerDisplayClientImpl();
