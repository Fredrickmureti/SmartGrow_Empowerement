/**
 * Track H4b — unit tests for {@link SessionEnvelopeStore}.
 *
 * Validates the four orthogonal protections promised by ADR-0014 Track H3:
 *   1. Round-trip success when ts / nonce / sig / sender all line up.
 *   2. Wrong-sender envelope is rejected even with a valid signature
 *      (defeats sibling-BrowserView replay).
 *   3. Skew > 30s is rejected.
 *   4. Same nonce twice within the TTL is rejected (defeats replay).
 *   5. `release(webContentsId)` invalidates the secret so a window-close
 *      cleanup actually closes the door.
 *   6. Tampered payload / tampered sig / bad shape all rejected.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionEnvelopeStore } from '../../../electron/hardware/SessionEnvelope';

const SENDER_A = 101;
const SENDER_B = 202;

function buildEnvelope(secret: string, ts: string, nonce: string, payload: unknown) {
  return {
    payload,
    ts,
    nonce,
    sig: SessionEnvelopeStore.sign(secret, ts, payload, nonce),
  };
}

describe('SessionEnvelopeStore (Track H3 / H4b)', () => {
  let now = 1_700_000_000_000; // ms
  let store: SessionEnvelopeStore;

  beforeEach(() => {
    now = 1_700_000_000_000;
    store = new SessionEnvelopeStore({ now: () => now });
  });

  it('round-trip: a freshly signed envelope verifies', () => {
    const secret = store.getOrCreateSecret(SENDER_A);
    const ts = Math.floor(now / 1000).toString();
    const env = buildEnvelope(secret, ts, 'nonce-a', { role: 'receipt_printer', op: 'print', idempotencyKey: 'k1' });
    const r = store.verify(SENDER_A, env);
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.payload as { op: string }).op).toBe('print');
  });

  it('mints a 64-char hex secret and returns the same secret on subsequent calls', () => {
    const s1 = store.getOrCreateSecret(SENDER_A);
    const s2 = store.getOrCreateSecret(SENDER_A);
    expect(s1).toBe(s2);
    expect(s1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects an envelope from a different sender (no secret bound)', () => {
    const secret = store.getOrCreateSecret(SENDER_A);
    const ts = Math.floor(now / 1000).toString();
    const env = buildEnvelope(secret, ts, 'nonce-b', { x: 1 });
    const r = store.verify(SENDER_B, env);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toMatch(/no session secret/i);
  });

  it('rejects an envelope signed with the wrong sender\'s secret', () => {
    store.getOrCreateSecret(SENDER_A);
    const secretB = store.getOrCreateSecret(SENDER_B);
    const ts = Math.floor(now / 1000).toString();
    // Sign with B's secret but deliver as if from A.
    const env = buildEnvelope(secretB, ts, 'nonce-c', { x: 1 });
    const r = store.verify(SENDER_A, env);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toMatch(/signature/i);
  });

  it('rejects timestamps more than 30s in the past', () => {
    const secret = store.getOrCreateSecret(SENDER_A);
    const oldTs = (Math.floor(now / 1000) - 60).toString();
    const env = buildEnvelope(secret, oldTs, 'nonce-d', { x: 1 });
    const r = store.verify(SENDER_A, env);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toMatch(/skew/i);
  });

  it('rejects timestamps more than 30s in the future', () => {
    const secret = store.getOrCreateSecret(SENDER_A);
    const futureTs = (Math.floor(now / 1000) + 60).toString();
    const env = buildEnvelope(secret, futureTs, 'nonce-e', { x: 1 });
    const r = store.verify(SENDER_A, env);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toMatch(/skew/i);
  });

  it('rejects nonce replay within the TTL', () => {
    const secret = store.getOrCreateSecret(SENDER_A);
    const ts = Math.floor(now / 1000).toString();
    const env = buildEnvelope(secret, ts, 'replay-me', { x: 1 });
    const first = store.verify(SENDER_A, env);
    expect(first.ok).toBe(true);
    const second = store.verify(SENDER_A, env);
    expect(second.ok).toBe(false);
    if (second.ok === false) expect(second.reason).toMatch(/nonce/i);
  });

  it('rejects tampered payload (signature no longer matches)', () => {
    const secret = store.getOrCreateSecret(SENDER_A);
    const ts = Math.floor(now / 1000).toString();
    const env = buildEnvelope(secret, ts, 'nonce-tp', { amount: 100 });
    const tampered = { ...env, payload: { amount: 9999 } };
    const r = store.verify(SENDER_A, tampered);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toMatch(/signature/i);
  });

  it('rejects bad envelope shape', () => {
    store.getOrCreateSecret(SENDER_A);
    expect(store.verify(SENDER_A, null).ok).toBe(false);
    expect(store.verify(SENDER_A, {}).ok).toBe(false);
    expect(store.verify(SENDER_A, { ts: '1', nonce: 'n' /* no sig */ }).ok).toBe(false);
  });

  it('release(webContentsId) invalidates the secret so subsequent verify fails', () => {
    const secret = store.getOrCreateSecret(SENDER_A);
    const ts = Math.floor(now / 1000).toString();
    const env = buildEnvelope(secret, ts, 'nonce-rel', { x: 1 });
    store.release(SENDER_A);
    const r = store.verify(SENDER_A, env);
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.reason).toMatch(/no session secret/i);
  });

  it('garbage-collects nonces older than the TTL (re-using a stale nonce after GC succeeds)', () => {
    const secret = store.getOrCreateSecret(SENDER_A);
    const ts = Math.floor(now / 1000).toString();
    const env = buildEnvelope(secret, ts, 'nonce-gc', { x: 1 });
    expect(store.verify(SENDER_A, env).ok).toBe(true);

    // Jump forward 6 minutes (TTL is 5min). Re-sign with a fresh ts so
    // the skew check doesn't reject before the nonce check.
    now += 6 * 60 * 1000;
    const ts2 = Math.floor(now / 1000).toString();
    const env2 = buildEnvelope(secret, ts2, 'nonce-gc', { x: 1 });
    const r = store.verify(SENDER_A, env2);
    expect(r.ok).toBe(true);
  });
});
