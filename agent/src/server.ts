import http from 'node:http';
import { handleStatus, startPeriodicDiscovery } from './routes/status.js';
import { handlePrint } from './routes/print.js';
import { handleTest } from './routes/test.js';
import { handleDiscover } from './routes/discover.js';
import { handleUsbDevices, handleUsbPrint } from './routes/usb.js';
import { dispatchBiometric } from './routes/biometric.js';
import { validateAuth, getAuthToken } from './auth.js';


const startTime = Date.now();

export function getUptime(): number {
  return Math.floor((Date.now() - startTime) / 1000);
}

// Wave 12 C1 — restrict CORS to known POS origins. Override via
// AGENT_ALLOWED_ORIGINS (comma-separated). Defaults cover local dev +
// the published Lovable preview/prod hosts.
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
];
const ALLOWED_ORIGINS = (process.env.AGENT_ALLOWED_ORIGINS?.split(',').map((s) => s.trim()).filter(Boolean) ?? [])
  .concat(DEFAULT_ALLOWED_ORIGINS);

function cors(res: http.ServerResponse, req?: http.IncomingMessage) {
  const origin = req?.headers.origin;
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
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

export function createServer() {
  // Start background device discovery
  startPeriodicDiscovery();

  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;
    const method = req.method?.toUpperCase() || 'GET';

    // CORS preflight
    if (method === 'OPTIONS') {
      cors(res, req);
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth check — skip for /status (allow unauthenticated health checks)
    if (path !== '/status' && !validateAuth(req)) {
      json(res, 401, { error: 'Unauthorized — provide Authorization: Bearer <token>' });
      return;
    }

    try {
      if (method === 'GET' && path === '/status') {
        return json(res, 200, handleStatus());
      }

      if (method === 'POST' && path === '/print') {
        const body = JSON.parse(await readBody(req));
        const result = await handlePrint(body);
        // 200 = agent did its job (whether printer accepted or not); body carries success flag.
        // 502 = upstream printer unreachable / timeout / refused.
        // 400 = bad request payload.
        const status = result.success
          ? 200
          : /Missing required fields/i.test(result.error || '') ? 400 : 502;
        return json(res, status, result);
      }

      if (method === 'POST' && path === '/test') {
        const body = JSON.parse(await readBody(req));
        const result = await handleTest(body);
        const status = result.success
          ? 200
          : /Missing required fields/i.test(result.error || '') ? 400 : 502;
        return json(res, status, result);
      }

      if (method === 'GET' && path === '/discover') {
        const subnet = url.searchParams.get('subnet') || 'auto';
        const result = await handleDiscover(subnet);
        return json(res, 200, result);
      }

      if (method === 'GET' && path === '/usb/devices') {
        const result = handleUsbDevices();
        return json(res, 200, result);
      }

      if (method === 'POST' && path === '/usb/print') {
        const body = JSON.parse(await readBody(req));
        const result = await handleUsbPrint(body);
        const status = result.success ? 200 : 502;
        return json(res, status, result);
      }

      // Biometric routes — vendor SDKs forward canonical events here.
      if (path.startsWith('/biometric/')) {
        const result = await dispatchBiometric(method, path, () => readBody(req));
        if (result) return json(res, result.status, result.body, req);
      }

      json(res, 404, { error: 'Not found' });

    } catch (err: any) {
      console.error(`[agent] Error handling ${method} ${path}:`, err);
      json(res, 500, { error: err.message || 'Internal server error' });
    }
  });
}
