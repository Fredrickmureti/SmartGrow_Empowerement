/**
 * Biometric agent route — verifies request validation, env-based secret
 * lookup, kind mapping, and HMAC signing of forwarded events.
 *
 * Runs under node:test so it stays inside the agent package without
 * requiring a vitest install in `/agent`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  handleBiometricHeartbeat,
  handleBiometricEvent,
  __test,
} from './biometric.js';

test('heartbeat: 400 on missing deviceId', async () => {
  const r = await handleBiometricHeartbeat(JSON.stringify({}));
  assert.equal(r.status, 400);
});

test('heartbeat: 200 with deviceId', async () => {
  const r = await handleBiometricHeartbeat(JSON.stringify({ deviceId: 'DEV-1' }));
  assert.equal(r.status, 200);
  assert.equal((r.body as { ack: boolean }).ack, true);
});

test('event: 400 on missing fields', async () => {
  const r = await handleBiometricEvent(JSON.stringify({ deviceId: 'DEV-1' }));
  assert.equal(r.status, 400);
});

test('event: 503 when ingest URL missing', async () => {
  delete process.env.BIOMETRIC_INGEST_URL;
  process.env[__test.envSecretKey('DEV-1')] = 'deadbeefdeadbeefdeadbeefdeadbeef';
  const r = await handleBiometricEvent(JSON.stringify({
    deviceId: 'DEV-1', externalEmployeeId: 'E-1', kind: 'check_in', occurredAt: new Date().toISOString(),
  }));
  assert.equal(r.status, 503);
});

test('event: 401 when device secret env missing', async () => {
  process.env.BIOMETRIC_INGEST_URL = 'http://localhost:0/ingest';
  delete process.env[__test.envSecretKey('DEV-X')];
  const r = await handleBiometricEvent(JSON.stringify({
    deviceId: 'DEV-X', externalEmployeeId: 'E-1', kind: 'check_in', occurredAt: new Date().toISOString(),
  }));
  assert.equal(r.status, 401);
});

test('event: forwards with valid HMAC headers and canonical body', async () => {
  const secretHex = 'a'.repeat(64);
  process.env[__test.envSecretKey('DEV-2')] = secretHex;

  let captured: { url: string; init: RequestInit } | null = null;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    captured = { url, init };
    return new Response(JSON.stringify({ accepted: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  process.env.BIOMETRIC_INGEST_URL = 'http://test.local/api/public/attendance/ingest';

  try {
    const occurredAt = '2026-06-17T10:00:00.000Z';
    const r = await handleBiometricEvent(JSON.stringify({
      deviceId: 'DEV-2', externalEmployeeId: 'E-42', kind: 'check_in', occurredAt, lat: 1.2, lng: 3.4, matchScore: 95,
    }));
    assert.equal(r.status, 200);
    assert.ok(captured);
    const headers = captured!.init.headers as Record<string, string>;
    assert.equal(headers['x-device-id'], 'DEV-2');
    const expectedSig = crypto.createHmac('sha256', Buffer.from(secretHex, 'hex')).update(captured!.init.body as string).digest('hex');
    assert.equal(headers['x-signature'], expectedSig);
    const body = JSON.parse(captured!.init.body as string);
    assert.equal(body.kind, 'in');
    assert.equal(body.employee_ref, 'E-42');
    assert.equal(body.ts, occurredAt);
    assert.equal(body.lat, 1.2);
    assert.equal(body.confidence, 0.95);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('kind mapping: unknown returns 400', async () => {
  process.env.BIOMETRIC_INGEST_URL = 'http://test.local/x';
  process.env[__test.envSecretKey('DEV-3')] = 'beef'.repeat(16);
  const r = await handleBiometricEvent(JSON.stringify({
    deviceId: 'DEV-3', externalEmployeeId: 'E-1', kind: 'unknown', occurredAt: new Date().toISOString(),
  }));
  assert.equal(r.status, 400);
});
