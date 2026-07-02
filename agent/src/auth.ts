/**
 * Simple shared-secret authentication for the agent.
 *
 * On first run, generates a random token and writes it to `~/.pos-agent-token`.
 * The POS web app reads this token and sends it as `Authorization: Bearer <token>`.
 *
 * If the env var `AGENT_AUTH_DISABLED=1` is set, auth is skipped (dev mode).
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import http from 'node:http';

const TOKEN_FILE = path.join(os.homedir(), '.pos-agent-token');

let _token: string | null = null;

function isAuthDisabled(): boolean {
  return process.env.AGENT_AUTH_DISABLED === '1' || process.env.AGENT_AUTH_DISABLED === 'true';
}

/**
 * Get or generate the auth token.
 * Returns null if auth is disabled.
 */
export function getAuthToken(): string | null {
  if (isAuthDisabled()) return null;

  if (_token) return _token;

  // Try to read existing token
  try {
    const existing = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
    if (existing.length >= 32) {
      _token = existing;
      return _token;
    }
  } catch {
    // File doesn't exist — generate new token
  }

  // Generate new token
  _token = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(TOKEN_FILE, _token, { mode: 0o600 });
    console.log(`[agent] Auth token saved to ${TOKEN_FILE}`);
  } catch (err) {
    console.warn(`[agent] Could not write token file: ${err}`);
  }

  return _token;
}

/**
 * Constant-time string comparison wrapper around `crypto.timingSafeEqual`.
 * Wave 11 R7 — the prior `a === b` comparison was timing-attack
 * vulnerable; local-only mitigated but technically wrong.
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    // length differs — still spend a comparison to avoid a length oracle
    const pad = Buffer.alloc(ab.length, 0);
    try { crypto.timingSafeEqual(ab, pad); } catch { /* noop */ }
    return false;
  }
  try {
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

/**
 * Validate an incoming request's Authorization header.
 * Returns true if the request is authorized.
 */
export function validateAuth(req: http.IncomingMessage): boolean {
  if (isAuthDisabled()) return true;

  const token = getAuthToken();
  if (!token) return true; // auth disabled or no token

  const authHeader = req.headers.authorization;
  if (!authHeader) return false;

  // Support "Bearer <token>" format
  const parts = authHeader.split(' ');
  if (parts.length === 2 && parts[0].toLowerCase() === 'bearer') {
    return safeEqual(parts[1], token);
  }

  // Also support raw token
  return safeEqual(authHeader, token);
}

