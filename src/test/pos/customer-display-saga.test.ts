/**
 * Customer-display saga (Loop B1) — verifies the domain event bus is
 * the single writer to customerDisplayClient and that:
 *  - pos.cart_total_changed → customerDisplayClient.update once per burst
 *  - pos.payment_completed  → customerDisplayClient.showComplete
 *  - pos.session_idle       → customerDisplayClient.reset
 *  - bursts within 250ms are deduped
 *  - subscribers are no-ops when the display is disconnected
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { domainEventBus, type DomainEvent } from '@/services/events/domainEventBus';

// Mock the customerDisplayClient BEFORE importing the mount component.
// Use vi.hoisted so the mocks survive vi.mock's top-of-file hoisting.
const { updateMock, showCompleteMock, resetMock, isConnectedMock } = vi.hoisted(() => ({
  updateMock: vi.fn().mockResolvedValue({ success: true }),
  showCompleteMock: vi.fn().mockResolvedValue({ success: true }),
  resetMock: vi.fn().mockResolvedValue({ success: true }),
  isConnectedMock: vi.fn().mockReturnValue(true),
}));

vi.mock('@/services/hardware/local-display/CustomerDisplayClient', () => ({
  customerDisplayClient: {
    update: updateMock,
    showComplete: showCompleteMock,
    reset: resetMock,
    isDisplayConnected: isConnectedMock,
  },
}));

// Stub remaining BusinessSagaMount deps so the saga can mount without
// touching the network. We only exercise the customer-display useEffect.
vi.mock('@/services/events/BusinessSaga', () => ({
  BusinessSaga: class { constructor(..._: unknown[]) {} register() {} start() {} stop() {} },
}));
vi.mock('@/services/printing/labelDispatch', () => ({ printLabelByTemplate: vi.fn() }));
vi.mock('@/services/hardware/HardwareClient', () => ({
  hardwareClient: { exec: vi.fn().mockResolvedValue({ success: true }) },
}));
vi.mock('@/services/hardware/SharedCommandQueueWorker', () => ({
  startSharedCommandQueueWorker: () => () => {},
  reclaimStaleBusinessEvents: vi.fn(),
}));
vi.mock('@/hooks/useBranches', () => ({ useBranches: () => ({ currentBranch: null }) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { from: () => ({ select: () => ({ eq: () => ({ data: [] }) }) }) } }));

import { BusinessSagaMount } from '@/components/events/BusinessSagaMount';

function mkEvent<T extends DomainEvent['type']>(type: T, payload: Record<string, unknown> = {}): DomainEvent {
  return {
    type,
    orgId: 'org-1',
    branchId: null,
    sourceDocType: 'pos_session',
    sourceDocId: 'cart',
    occurredAt: new Date().toISOString(),
    payload,
  };
}

describe('customer-display saga', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    updateMock.mockClear();
    showCompleteMock.mockClear();
    resetMock.mockClear();
    isConnectedMock.mockReturnValue(true);
    domainEventBus._reset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function mount() {
    return renderHook(() => BusinessSagaMount({ orgId: 'org-1' }));
  }

  it('cart_total_changed → update once', async () => {
    mount();
    await act(async () => {
      await domainEventBus.publish(mkEvent('pos.cart_total_changed', {
        items: [{ id: 'p1', name: 'Soda', quantity: 1, unitPrice: 100, lineTotal: 100 }],
        subtotal: 100, tax: 0, discount: 0, total: 100, itemCount: 1,
      }));
    });
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0][0]).toMatchObject({ status: 'scanning', total: 100 });
  });

  it('bursts within 250ms dedupe to a single update', async () => {
    mount();
    await act(async () => {
      await domainEventBus.publish(mkEvent('pos.cart_total_changed', { items: [], itemCount: 0, subtotal: 0, total: 0, tax: 0, discount: 0 }));
      await domainEventBus.publish(mkEvent('pos.cart_total_changed', { items: [], itemCount: 0, subtotal: 0, total: 0, tax: 0, discount: 0 }));
    });
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it('payment_completed → showComplete and schedules reset', async () => {
    mount();
    await act(async () => {
      await domainEventBus.publish(mkEvent('pos.payment_completed', { total: 250, customerName: 'Alice' }));
    });
    expect(showCompleteMock).toHaveBeenCalledWith(250, 'Alice');
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(resetMock).toHaveBeenCalled();
  });

  it('session_idle → reset and clears dedupe', async () => {
    mount();
    // First cart event — recorded
    await act(async () => {
      await domainEventBus.publish(mkEvent('pos.cart_total_changed', { items: [], itemCount: 0, subtotal: 0, total: 0, tax: 0, discount: 0 }));
    });
    expect(updateMock).toHaveBeenCalledTimes(1);
    // Idle clears the dedupe map
    await act(async () => {
      await domainEventBus.publish(mkEvent('pos.session_idle', {}));
    });
    expect(resetMock).toHaveBeenCalled();
    // Next cart event should fire again (not deduped)
    await act(async () => {
      await domainEventBus.publish(mkEvent('pos.cart_total_changed', { items: [{ id: 'p2', name: 'Bread', quantity: 1, unitPrice: 50, lineTotal: 50 }], itemCount: 1, subtotal: 50, total: 50, tax: 0, discount: 0 }));
    });
    expect(updateMock).toHaveBeenCalledTimes(2);
  });

  it('no writes when display disconnected', async () => {
    isConnectedMock.mockReturnValue(false);
    mount();
    await act(async () => {
      await domainEventBus.publish(mkEvent('pos.cart_total_changed', { items: [], itemCount: 0, subtotal: 0, total: 0, tax: 0, discount: 0 }));
      await domainEventBus.publish(mkEvent('pos.session_idle', {}));
    });
    expect(updateMock).not.toHaveBeenCalled();
    expect(resetMock).not.toHaveBeenCalled();
  });
});
