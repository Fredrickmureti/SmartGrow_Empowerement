import http from 'node:http';
import https from 'node:https';
import { handleStatus, startPeriodicDiscovery } from './routes/status.js';
import { handlePrint } from './routes/print.js';
import { handleTest } from './routes/test.js';
import { handleDiscover } from './routes/discover.js';
import { handleUsbDevices, handleUsbPrint } from './routes/usb.js';
import { dispatchBiometric } from './routes/biometric.js';
import { handleHealth } from './routes/health.js';
import { buildSupportBundle } from './routes/support.js';
import { handleLogsStream } from './routes/logs-stream.js';
import { validateAuth } from './auth.js';
import { acceptNonce } from './nonce.js';
import { logger } from './logger.js';
import type { LoopbackTls } from './tls.js';

const startTime = Date.now();

export function getUptime(): number {
  return Math.floor((Date.now() - startTime) / 1000);
}

// AccrualFlow Edge — Phase 1 hardening.
//
// Allowed origins default covers local dev + the production ERP
// (https://www.accrualflow.systems) and the Lovable preview hosts.
// Additional origins can be appended via AGENT_ALLOWED_ORIGINS.
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:8080',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
  'https://www.accrualflow.systems',
  'https://accrualflow.systems',
];
const ALLOWED_ORIGINS = Array.from(
  new Set(
    (process.env.AGENT_ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean) ?? [])
      .concat(DEFAULT_ALLOWED_ORIGINS),
  ),
);

const AGENT_PORT = parseInt(process.env.AGENT_PORT || '8043', 10);
const AGENT_TLS_PORT = parseInt(process.env.AGENT_TLS_PORT || '8443', 10);

// DNS-rebinding defense: only accept Host headers that resolve to the
// local listener. A malicious page cannot use a rebound DNS name to
// hit us in a browser context because the Host header will not match.
const ALLOWED_HOSTS = new Set([
  `127.0.0.1:${AGENT_PORT}`,
  `localhost:${AGENT_PORT}`,
  `[::1]:${AGENT_PORT}`,
  `127.0.0.1:${AGENT_TLS_PORT}`,
  `localhost:${AGENT_TLS_PORT}`,
  `[::1]:${AGENT_TLS_PORT}`,
]);

// Routes that mutate hardware state MUST carry a fresh X-Edge-Nonce.
const MUTATING_PATHS = new Set(['/print', '/test', '/usb/print']);

function cors(res: http.ServerResponse, req?: http.IncomingMessage) {
  const origin = req?.headers.origin;
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Edge-Nonce');
  // Chrome Private Network Access — required for HTTPS→loopback in prod.
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Max-Age', '600');
}

function corsHeaderMap(req?: http.IncomingMessage): Record<string, string> {
  const origin = req?.headers.origin;
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Edge-Nonce',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '600',
  };
}

function json(res: http.ServerResponse, status: number, body: unknown, req?: http.IncomingMessage) {
  cors(res, req);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

function validateHost(req: http.IncomingMessage): boolean {
  const host = req.headers.host?.toLowerCase();
  if (!host) return false;
  return ALLOWED_HOSTS.has(host);
}

// Shared request handler used by both the http and https listeners.
function buildHandler(tlsInfo: LoopbackTls | null) {
  return async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;
    const method = req.method?.toUpperCase() || 'GET';

    if (method === 'OPTIONS') {
      cors(res, req);
      res.writeHead(204);
      res.end();
      return;
    }

    if (!validateHost(req)) {
      logger.warn('rejected_host', { host: req.headers.host, path });
      return json(res, 421, { error: 'Misdirected request — invalid Host' }, req);
    }

    // /status, /health, and /tls-info are the only unauthenticated routes.
    // /tls-info exposes only the SHA-256 fingerprint so the ERP can pin
    // it after enrolment; no private material is disclosed.
    const isPublic = path === '/status' || path === '/health' || path === '/tls-info';
    if (!isPublic && !validateAuth(req)) {
      return json(res, 401, { error: 'Unauthorized — provide Authorization: Bearer <token>' }, req);
    }

    if (MUTATING_PATHS.has(path)) {
      const nonce = req.headers['x-edge-nonce'];
      const nonceStr = Array.isArray(nonce) ? nonce[0] : nonce;
      if (!acceptNonce(nonceStr)) {
        logger.warn('nonce_rejected', { path, hasNonce: Boolean(nonceStr) });
        return json(res, 409, { error: 'Nonce missing or replayed — send fresh X-Edge-Nonce' }, req);
      }
    }

    try {
      if (method === 'GET' && path === '/status') return json(res, 200, handleStatus(), req);
      if (method === 'GET' && path === '/health') return json(res, 200, handleHealth(tlsInfo), req);
      if (method === 'GET' && path === '/tls-info') {
        return json(res, 200, tlsInfo
          ? { enabled: true, fingerprint_sha256: tlsInfo.fingerprintSha256, generated_at: tlsInfo.generatedAt, port: AGENT_TLS_PORT }
          : { enabled: false }, req);
      }
      if (method === 'GET' && path === '/support-bundle') {
        return json(res, 200, buildSupportBundle({
          port: AGENT_PORT,
          allowed_origins: ALLOWED_ORIGINS,
          auth_disabled: process.env.AGENT_AUTH_DISABLED === '1' || process.env.AGENT_AUTH_DISABLED === 'true',
        }), req);
      }
      if (method === 'GET' && path === '/logs/stream') {
        return handleLogsStream(req, res, corsHeaderMap(req));
      }
      if (method === 'POST' && path === '/print') {
        const body = JSON.parse(await readBody(req));
        const result = await handlePrint(body);
        const status = result.success ? 200 : /Missing required fields/i.test(result.error || '') ? 400 : 502;
        return json(res, status, result, req);
      }
      if (method === 'POST' && path === '/test') {
        const body = JSON.parse(await readBody(req));
        const result = await handleTest(body);
        const status = result.success ? 200 : /Missing required fields/i.test(result.error || '') ? 400 : 502;
        return json(res, status, result, req);
      }
      if (method === 'GET' && path === '/discover') {
        const subnet = url.searchParams.get('subnet') || 'auto';
        const result = await handleDiscover(subnet);
        return json(res, 200, result, req);
      }
      if (method === 'GET' && path === '/usb/devices') return json(res, 200, handleUsbDevices(), req);
      if (method === 'POST' && path === '/usb/print') {
        const body = JSON.parse(await readBody(req));
        const result = await handleUsbPrint(body);
        return json(res, result.success ? 200 : 502, result, req);
      }
      if (path.startsWith('/biometric/')) {
        const result = await dispatchBiometric(method, path, () => readBody(req));
        if (result) return json(res, result.status, result.body, req);
      }
      json(res, 404, { error: 'Not found' }, req);
    } catch (err: any) {
      logger.error('request_failed', { method, path, error: err?.message });
      json(res, 500, { error: err.message || 'Internal server error' }, req);
    }
  };
}

export function createServer(tlsInfo: LoopbackTls | null = null) {
  startPeriodicDiscovery();
  return http.createServer(buildHandler(tlsInfo));
}

export function createTlsServer(tlsInfo: LoopbackTls) {
  return https.createServer(
    { cert: tlsInfo.cert, key: tlsInfo.key, minVersion: 'TLSv1.2' },
    buildHandler(tlsInfo),
  );
}
