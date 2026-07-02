import { describe, it, expect, vi } from 'vitest';
import { PaymentStateMachine, canTransition, isTerminal, InvalidTransitionError } from '../../../electron/hardware/payment/PaymentStateMachine';

describe('PaymentStateMachine — FSM (Track P)', () => {
  it('allows the canonical happy path: idle→collecting→authorizing→approved→captured→settled', () => {
    const m = new PaymentStateMachine('t1');
    m.transition('collecting');
    m.transition('authorizing');
    m.transition('approved');
    m.transition('captured');
    m.transition('settled');
    expect(m.state).toBe('settled');
    expect(m.isTerminal()).toBe(true);
  });

  it('rejects invalid transitions', () => {
    const m = new PaymentStateMachine('t2');
    expect(() => m.transition('approved')).toThrow(InvalidTransitionError);
    m.transition('collecting');
    expect(() => m.transition('settled')).toThrow(InvalidTransitionError);
  });

  it('terminal states accept no further transitions', () => {
    for (const t of ['declined', 'cancelled', 'voided', 'refunded', 'error'] as const) {
      expect(isTerminal(t)).toBe(true);
      expect(canTransition(t, 'approved')).toBe(false);
    }
  });

  it('emits events on each transition', () => {
    const m = new PaymentStateMachine('t3');
    const sink = vi.fn();
    m.on(sink);
    m.transition('collecting', 'card present');
    m.transition('authorizing');
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls[0][0]).toMatchObject({ txnId: 't3', from: 'idle', to: 'collecting', reason: 'card present' });
  });

  it('error is always reachable from non-terminal states', () => {
    expect(canTransition('idle', 'error')).toBe(true);
    expect(canTransition('collecting', 'error')).toBe(true);
    expect(canTransition('approved', 'error')).toBe(true);
    // but not from terminal
    expect(canTransition('refunded', 'error')).toBe(false);
  });
});