/**
 * Device Identity Service
 * 
 * Primary device identity: a persistent UUID stored in localStorage.
 * Secondary: a computed browser fingerprint for anomaly detection only.
 * 
 * The UUID is the ONLY value used for PIN lookup / device matching.
 * If localStorage is cleared, the device is treated as new (no PIN).
 */

export interface DeviceInfo {
  fingerprint: string;
  deviceName: string;
  browser: string;
  browserVersion: string;
  os: string;
  osVersion: string;
  deviceType: 'desktop' | 'mobile' | 'tablet' | 'unknown';
  userAgent: string;
}

interface UAParser {
  browser: { name: string; version: string };
  os: { name: string; version: string };
  device: { type: string };
}

const DEVICE_ID_KEY = 'device_id';
const LEGACY_FINGERPRINT_KEY = 'device_fingerprint';

// ─── Primary Identity: Persistent Device ID ──────────────────────

/**
 * Get or create a persistent device identifier.
 * 
 * Migration logic:
 * 1. If `device_id` exists in localStorage → use it (new model).
 * 2. Else if `device_fingerprint` exists → adopt it as `device_id` so
 *    existing PIN records (keyed on the old hash) still match.
 * 3. Otherwise generate a fresh UUID.
 */
export function getOrCreateDeviceId(): string {
  try {
    // 1. Check for new-model device ID
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) {
      return existing;
    }

    // 2. Migrate legacy fingerprint → adopt as device ID
    const legacy = localStorage.getItem(LEGACY_FINGERPRINT_KEY);
    if (legacy) {
      localStorage.setItem(DEVICE_ID_KEY, legacy);
      return legacy;
    }

    // 3. Brand-new device — generate UUID
    const id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    // If localStorage is unavailable (e.g. private browsing quota),
    // generate a transient ID — PIN won't persist across sessions.
    return crypto.randomUUID();
  }
}

function isValidUUID(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/**
 * The canonical device identifier for all PIN / device-tracking operations.
 * Replaces the old `generateDeviceFingerprint()` as the primary key.
 */
export async function getDeviceIdentifier(): Promise<string> {
  // Check Electron first
  const electronId = await getElectronDeviceId();
  if (electronId) return electronId;

  return getOrCreateDeviceId();
}

// ─── Secondary: Computed Fingerprint (anomaly detection only) ────

/**
 * Compute a browser fingerprint from signals.
 * NOT used as primary device ID — only for detecting environment changes.
 */
export async function computeBrowserFingerprint(): Promise<string> {
  const components: string[] = [];

  components.push(navigator.userAgent);
  components.push(navigator.language);
  components.push(navigator.languages?.join(',') || '');
  components.push(String(navigator.hardwareConcurrency || 0));
  components.push(String(navigator.maxTouchPoints || 0));
  components.push(`${screen.width}x${screen.height}`);
  components.push(`${screen.colorDepth}`);
  components.push(`${window.devicePixelRatio || 1}`);
  components.push(String(new Date().getTimezoneOffset()));
  components.push(Intl.DateTimeFormat().resolvedOptions().timeZone);
  components.push(navigator.platform || '');

  return sha256(components.join('|'));
}

// ─── Device Info (unchanged) ─────────────────────────────────────

function parseUserAgent(ua: string): UAParser {
  const result: UAParser = {
    browser: { name: 'Unknown', version: '' },
    os: { name: 'Unknown', version: '' },
    device: { type: 'desktop' },
  };

  if (ua.includes('Firefox/')) {
    result.browser.name = 'Firefox';
    result.browser.version = ua.match(/Firefox\/(\d+(\.\d+)?)/)?.[1] || '';
  } else if (ua.includes('Edg/')) {
    result.browser.name = 'Edge';
    result.browser.version = ua.match(/Edg\/(\d+(\.\d+)?)/)?.[1] || '';
  } else if (ua.includes('Chrome/')) {
    result.browser.name = 'Chrome';
    result.browser.version = ua.match(/Chrome\/(\d+(\.\d+)?)/)?.[1] || '';
  } else if (ua.includes('Safari/') && !ua.includes('Chrome')) {
    result.browser.name = 'Safari';
    result.browser.version = ua.match(/Version\/(\d+(\.\d+)?)/)?.[1] || '';
  } else if (ua.includes('Opera') || ua.includes('OPR/')) {
    result.browser.name = 'Opera';
    result.browser.version = ua.match(/(?:Opera|OPR)\/(\d+(\.\d+)?)/)?.[1] || '';
  }

  if (ua.includes('Windows NT 10')) {
    result.os.name = 'Windows';
    result.os.version = ua.includes('Windows NT 10.0; Win64') ? '11' : '10';
  } else if (ua.includes('Windows NT')) {
    result.os.name = 'Windows';
    result.os.version = ua.match(/Windows NT (\d+\.\d+)/)?.[1] || '';
  } else if (ua.includes('Mac OS X')) {
    result.os.name = 'macOS';
    result.os.version = ua.match(/Mac OS X (\d+[._]\d+)/)?.[1]?.replace(/_/g, '.') || '';
  } else if (ua.includes('iPhone') || ua.includes('iPad')) {
    result.os.name = 'iOS';
    result.os.version = ua.match(/OS (\d+[._]\d+)/)?.[1]?.replace(/_/g, '.') || '';
  } else if (ua.includes('Android')) {
    result.os.name = 'Android';
    result.os.version = ua.match(/Android (\d+(\.\d+)?)/)?.[1] || '';
  } else if (ua.includes('Linux')) {
    result.os.name = 'Linux';
    result.os.version = '';
  }

  if (ua.includes('Mobile') || ua.includes('iPhone') || ua.includes('Android')) {
    if (ua.includes('iPad') || ua.includes('Tablet')) {
      result.device.type = 'tablet';
    } else {
      result.device.type = 'mobile';
    }
  } else {
    result.device.type = 'desktop';
  }

  return result;
}

async function sha256(message: string): Promise<string> {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function getDeviceInfo(): Promise<DeviceInfo> {
  const fingerprint = await getDeviceIdentifier();
  const ua = navigator.userAgent;
  const parsed = parseUserAgent(ua);

  const deviceName = `${parsed.browser.name} on ${parsed.os.name}${parsed.os.version ? ' ' + parsed.os.version : ''}`;

  return {
    fingerprint,
    deviceName,
    browser: parsed.browser.name,
    browserVersion: parsed.browser.version,
    os: parsed.os.name,
    osVersion: parsed.os.version,
    deviceType: parsed.device.type as DeviceInfo['deviceType'],
    userAgent: ua,
  };
}

/**
 * Clear stored device ID (for testing or device reset)
 */
export function clearStoredFingerprint(): void {
  try {
    localStorage.removeItem(DEVICE_ID_KEY);
    // Also clean up legacy key if present
    localStorage.removeItem('device_fingerprint');
  } catch {
    // Ignore errors
  }
}

export function isElectronEnvironment(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bridge: any = typeof window !== 'undefined' ? (window as any).pos : undefined;
  return !!bridge?.isElectron;
}


export async function getElectronDeviceId(): Promise<string | null> {
  if (!isElectronEnvironment()) return null;
  // Track H2 — `getDeviceId` was previously a private electronAPI surface;
  // it is not in the capability-scoped window.pos namespace. Device-ID
  // generation now lives entirely in the renderer fingerprint path below.
  return null;
}

// Legacy alias — kept for backward compatibility during migration
export const generateDeviceFingerprint = getDeviceIdentifier;
