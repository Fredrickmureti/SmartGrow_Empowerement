import { describe, it, expect, beforeEach } from 'vitest';
import { CommandRouter, validateExecCommand } from '../../../electron/hardware/CommandRouter';

const key = '00000000-0000-4000-8000-000000000001';

describe('CommandRouter — schema validation', () => {
  it('rejects unknown roles', () => {
    const r = validateExecCommand({ role: 'mainframe', op: 'print', idempotencyKey: key });
    expect(r.ok).toBe(false);
  });
  it('rejects missing idempotencyKey', () => {
    const r = validateExecCommand({ role: 'receipt_printer', op: 'print_receipt' });
    expect(r.ok).toBe(false);
  });
  it('rejects oversized op strings', () => {
    const r = validateExecCommand({ role: 'receipt_printer', op: 'x'.repeat(200), idempotencyKey: key });
    expect(r.ok).toBe(false);
  });
  it('accepts a well-formed command', () => {
    const r = validateExecCommand({ role: 'cash_drawer', op: 'open', payload: { pin: 2 }, idempotencyKey: key });
    expect(r.ok).toBe(true);
  });
  it('rejects out-of-range maxAttempts', () => {
    const r = validateExecCommand({ role: 'cash_drawer', op: 'open', idempotencyKey: key, maxAttempts: 99 });
    expect(r.ok).toBe(false);
  });
});

describe('CommandRouter — dispatch', () => {
  let router: CommandRouter;
  beforeEach(() => { router = new CommandRouter(); });

  it('dispatches to the registered handler', async () => {
    router.register('cash_drawer', 'open', async () => ({ ok: true, result: 'kicked' }));
    const res = await router.exec({ role: 'cash_drawer', op: 'open', payload: {}, idempotencyKey: key });
    expect(res).toEqual({ ok: true, result: 'kicked' });
  });

  it('returns a structured error for unknown ops', async () => {
    const res = await router.exec({ role: 'cash_drawer', op: 'self_destruct', idempotencyKey: key });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unknown op/);
  });

  it('catches handler exceptions', async () => {
    router.register('scale', 'read_weight', async () => { throw new Error('serial closed'); });
    const res = await router.exec({ role: 'scale', op: 'read_weight', idempotencyKey: key });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('serial closed');
  });

  it('forbids duplicate registrations', () => {
    router.register('cash_drawer', 'open', async () => ({ ok: true }));
    expect(() => router.register('cash_drawer', 'open', async () => ({ ok: true }))).toThrow(/duplicate/);
  });

  it('invokes the audit callback on every call', async () => {
    const audit: unknown[] = [];
    const r = new CommandRouter({ audit: (cmd, res) => audit.push({ cmd, res }) });
    r.register('cash_drawer', 'open', async () => ({ ok: true }));
    await r.exec({ role: 'cash_drawer', op: 'open', idempotencyKey: key });
    await r.exec({ role: 'cash_drawer', op: 'nope', idempotencyKey: key });
    expect(audit.length).toBe(2);
  });
});
