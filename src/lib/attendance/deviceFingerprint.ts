/**
 * Stable per-browser fingerprint for attendance device binding.
 *
 * Not cryptographically anti-spoof — its job is to make casual buddy-punching
 * (sharing a phone, logging in on a coworker's laptop) leave a clear forensic
 * trail. The fingerprint is hashed client-side so we never store raw signals.
 */

function canvasSignal(): string {
  try {
    const c = document.createElement("canvas");
    c.width = 200; c.height = 50;
    const ctx = c.getContext("2d");
    if (!ctx) return "";
    ctx.textBaseline = "top";
    ctx.font = "14px 'Arial'";
    ctx.fillStyle = "#069";
    ctx.fillText("attendance-fp", 2, 2);
    ctx.fillStyle = "rgba(102,204,0,0.7)";
    ctx.fillText("attendance-fp", 4, 17);
    return c.toDataURL();
  } catch { return ""; }
}

async function sha256(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

const STORAGE_KEY = "attendance.device_fp.v1";

export async function getDeviceFingerprint(): Promise<string> {
  const cached = localStorage.getItem(STORAGE_KEY);
  if (cached) return cached;

  const parts = [
    navigator.userAgent,
    navigator.language,
    `${screen.width}x${screen.height}x${screen.colorDepth}`,
    new Date().getTimezoneOffset().toString(),
    navigator.hardwareConcurrency?.toString() ?? "",
    (navigator as any).deviceMemory?.toString() ?? "",
    canvasSignal(),
  ].join("|");

  const fp = await sha256(parts);
  localStorage.setItem(STORAGE_KEY, fp);
  return fp;
}

export interface GeoPosition {
  lat: number;
  lng: number;
  accuracy_m: number;
}

export function getCurrentPosition(timeoutMs = 8000): Promise<GeoPosition | null> {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy_m: p.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30_000 }
    );
  });
}
