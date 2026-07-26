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

export interface EdgeBridge {
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
    start(): Promise<{ ok: boolean; pid?: number; error?: string }>;
    stop(): Promise<{ ok: boolean }>;
    status(): Promise<{ running: boolean; pid: number | null }>;
    probe(payload: ProbeRequest): Promise<ProbeResponse>;
  };
  shell: { openExternal(url: string): Promise<void> };
}

declare global {
  interface Window { edge: EdgeBridge }
}
