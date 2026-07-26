/**
 * GET /logs/stream — Server-Sent Events tail of the agent's ring buffer.
 *
 * Phase 4.2 item 3. Replaces the on-demand `/status` pull in the desktop
 * shell's Logs viewer so operators see live activity without hammering
 * the process.
 *
 * Security:
 *   - Auth enforced upstream in server.ts (this route is NOT in the
 *     public allowlist).
 *   - Origin allowlist + Host pin already applied by server.ts.
 *   - Concurrent-stream cap (MAX_STREAMS) prevents fd exhaustion.
 *   - Heartbeat every 15s so proxies don't kill the connection.
 */

import type http from 'node:http';
import { logger, recentLogs, subscribeLogs, activeLogSubscriberCount } from '../logger.js';

const MAX_STREAMS = 3;

export function handleLogsStream(req: http.IncomingMessage, res: http.ServerResponse, corsHeaders: Record<string, string>): void {
  if (activeLogSubscriberCount() >= MAX_STREAMS) {
    res.writeHead(429, { 'Content-Type': 'application/json', ...corsHeaders });
    res.end(JSON.stringify({ error: 'Too many log streams open — try again shortly.' }));
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...corsHeaders,
  });

  const write = (event: string, data: unknown) => {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch { /* client gone; cleaned up by 'close' */ }
  };

  // Replay the recent ring buffer so the viewer has immediate context.
  for (const e of recentLogs()) write('log', e);

  const unsub = subscribeLogs((e) => write('log', e));
  const heartbeat = setInterval(() => {
    try { res.write(`: heartbeat ${Date.now()}\n\n`); } catch { /* noop */ }
  }, 15_000);

  const done = () => {
    clearInterval(heartbeat);
    unsub();
    try { res.end(); } catch { /* noop */ }
  };
  req.on('close', done);
  req.on('error', () => { logger.warn('logs_stream_client_error'); done(); });
}