/**
 * Type surface for the IPC bridge exposed by `electron/preload.cjs`. Keep in
 * lock-step with the `contextBridge.exposeInMainWorld('edge', …)` call.
 */
export interface WorkstationRead {
  exists: boolean;
  workstation_id?: string | null;
  organization_id?: string | null;
  name?: string | null;
  supabase_url?: string | null;
  has_secret?: boolean;
  error?: string;
}

export interface WorkstationWritePayload {
  workstation_id: string;
  organization_id: string;
  name: string;
  supabase_url: string;
  workstation_secret: string;
}

export interface ProbeTarget {
  transport?: 'network' | 'usb';
  driver?: string;
  ipAddress?: string;
  port?: number;
  vendorId?: number;
  productId?: number;
}
export type ProbeOp = 'printer.test_page' | 'drawer.kick' | 'network.ping' | 'usb.list';
export interface ProbeRequest {
  deviceId?: string;
  role?: string;
  op: ProbeOp;
  target?: ProbeTarget;
}
export interface ProbeResponse {
  status: number;
  success: boolean;
  op?: ProbeOp;
  deviceId?: string;
  error?: string;
  detail?: string;
  responseTimeMs?: number;
  bytesWritten?: number;
  data?: unknown;
  cached?: boolean;
  cooldownMs?: number;
}

/**
 * Loopback pairing material for browsers on this machine. `token` is the
 * `~/.pos-agent-token` shared secret; it is never returned when the runtime
 * is started with `AGENT_AUTH_DISABLED=1`.
 */
export interface AgentPairing {
  ok: boolean;
  authDisabled: boolean;
  token: string | null;
  tokenPath: string;
  baseUrl: string;
  tlsUrl: string;
  error?: string;
}

export interface EdgeBridge {
  /** Loopback pairing material — NOT the cloud workstation secret. */
  workstation: {
    read(): Promise<WorkstationRead>;
    write(p: WorkstationWritePayload): Promise<{ ok: boolean; error?: string }>;
    clear(): Promise<{ ok: boolean; error?: string }>;
  };
  settings: {
    read(): Promise<Record<string, unknown>>;
    write(next: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>;
  };
  agent: {
    start(): Promise<{ ok: boolean; pid?: number | null; error?: string; detail?: string; external?: boolean; mode?: string; log?: Array<{ ts: string; level: string; msg: string }> }>;
    stop(): Promise<{ ok: boolean }>;
    status(): Promise<{ running: boolean; pid: number | null; source?: string; version?: string | null; error?: string; supervised?: boolean; restarting?: boolean }>;
    logs(): Promise<{ ok: boolean; status?: number; error?: string; source?: string; generated_at?: string; entries: Array<{ ts: string; level: string; msg: string; [k: string]: unknown }> }>;
    pairing(): Promise<AgentPairing>;
    rotateToken(): Promise<{ ok: boolean; token?: string; error?: string; detail?: string }>;
    probe(payload: ProbeRequest): Promise<ProbeResponse>;
  };
  supervisor: {
    status(): Promise<SupervisorStatus>;
    ping(): Promise<{ ok: boolean; pong?: number; error?: string }>;
    reload(): Promise<{ ok: boolean; error?: string }>;
    shutdown(): Promise<{ ok: boolean; error?: string }>;
    install(): Promise<InstallerResult>;
    uninstall(): Promise<InstallerResult>;
    start(): Promise<InstallerResult>;
    stop(): Promise<InstallerResult>;
    serviceStatus(): Promise<InstallerResult & { installerAvailable?: boolean }>;
    certStatus(): Promise<CertStatus>;
    rotateCert(): Promise<{ ok: boolean; fingerprint_sha256?: string | null; error?: string }>;
    installCert(): Promise<TrustResult>;
    uninstallCert(): Promise<TrustResult>;
  };
  updates: {
    check(opts?: { channel?: string; channelUrl?: string }): Promise<UpdateCheck>;
  };
  shell: { openExternal(url: string): Promise<void> };
}

export interface UpdateCheck {
  ok: boolean;
  error?: string;
  /** False when no release channel URL is configured for this install. */
  configured?: boolean;
  state?: 'not_configured' | 'no_release' | 'unreachable' | 'malformed_manifest' | 'channel_error' | 'checked';
  url?: string;
  channel?: string;
  current_version?: string;
  latest_version?: string | null;
  /** A newer build exists for this platform. */
  update_available?: boolean;
  /** True when this device is inside the staged-rollout slice. */
  applies_to_this_device?: boolean;
  /** Below `minimum_version` — rollout gating is bypassed. */
  mandatory?: boolean;
  rollout?: number;
  rollout_bucket?: number;
  platform?: string;
  notes?: string | null;
  pub_date?: string | null;
  download_url?: string | null;
  sha256?: string | null;
  unsupported_platform?: boolean;
}

export interface CertStatus {
  ok: boolean;
  /** `null` when the platform can't be queried reliably — treat as untrusted. */
  trusted?: boolean | null;
  detail?: string;
  /** Exact commands `installCert()` will run, for operator review. */
  commands?: Array<{ command: string; explain: string; elevates: boolean }>;
  error?: string;
}

export interface TrustResult {
  ok: boolean;
  platform?: string;
  certPath?: string;
  steps?: Array<{ command: string; ok: boolean; output: string }>;
  error?: string;
}

export interface SupervisorStatus {
  ok: boolean;
  error?: string;
  version?: string;
  pid?: number;
  uptime_s?: number;
  platform?: string;
  workstation_id?: string | null;
  tls?: { enabled: boolean; fingerprint_sha256: string | null; port: number | null };
}


export interface InstallerResult {
  ok: boolean;
  code?: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
  detail?: string;
}

declare global {
  interface Window { edge: EdgeBridge }
}
