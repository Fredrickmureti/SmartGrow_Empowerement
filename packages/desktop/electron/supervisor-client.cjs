/**
 * Phase 4.2.6 — Electron-side client for the agent supervisor pipe.
 *
 * Opens the platform-native IPC channel (named pipe on Windows, unix
 * socket on POSIX), authenticates with the token in
 * ~/.accrualflow/edge/supervisor.token, and sends a single newline-
 * delimited JSON command. Used by main.cjs to expose a small
 * `supervisor:*` IPC surface to the renderer without ever letting the DOM
 * see the token or the raw socket.
 */
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EDGE_HOME = path.join(os.homedir(), '.accrualflow', 'edge');
const TOKEN_PATH = path.join(EDGE_HOME, 'supervisor.token');
const SOCK_PATH = process.platform === 'win32'
  ? '\\\\.\\pipe\\accrualflow-edge'
  : path.join(EDGE_HOME, 'supervisor.sock');

function readToken() {
  try { return fs.readFileSync(TOKEN_PATH, 'utf-8').trim(); } catch { return null; }
}

function send(op, extra = {}, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const token = readToken();
    if (!token) return resolve({ ok: false, error: 'supervisor_not_running' });
    const sock = net.createConnection(SOCK_PATH);
    let buf = '';
    const done = (v) => { try { sock.destroy(); } catch { /* ignore */ } resolve(v); };
    const timer = setTimeout(() => done({ ok: false, error: 'supervisor_timeout' }), timeoutMs);
    sock.setEncoding('utf-8');
    sock.on('connect', () => sock.write(JSON.stringify({ op, token, ...extra }) + '\n'));
    sock.on('data', (chunk) => {
      buf += chunk;
      const idx = buf.indexOf('\n');
      if (idx !== -1) {
        clearTimeout(timer);
        try { done(JSON.parse(buf.slice(0, idx))); }
        catch { done({ ok: false, error: 'invalid_response' }); }
      }
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      const code = err && err.code;
      done({ ok: false, error: code === 'ENOENT' || code === 'ECONNREFUSED' ? 'supervisor_not_running' : String(err.message || err) });
    });
  });
}

module.exports = { send, SOCK_PATH, TOKEN_PATH };