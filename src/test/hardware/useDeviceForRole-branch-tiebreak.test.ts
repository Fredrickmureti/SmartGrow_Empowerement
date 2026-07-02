/**
 * Regression test for `useDeviceForRole` multi-branch determinism.
 *
 * Pre-fix: when a tenant had two `receipt_printer` assignments — one per
 * branch — and neither row was `is_default`, the hook returned `pool[0]`,
 * which meant branch A could silently print on branch B's device
 * depending on Postgres row ordering. The 4-layer selector (scope →
 * active business → is_default → first) fixes this. These tests pin the
 * behaviour so the next refactor cannot regress it silently.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDeviceForRole } from '@/hooks/useDeviceForRole';
import type { DeviceAssignment } from '@/hooks/useDeviceAssignments';

vi.mock('@/hooks/useDeviceAssignments', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useDeviceAssignments')>(
    '@/hooks/useDeviceAssignments',
  );
  return {
    ...actual,
    useDeviceAssignments: vi.fn(),
  };
});

vi.mock('@/hooks/useBusinesses', () => ({
  useBusinesses: vi.fn(),
}));

import { useDeviceAssignments } from '@/hooks/useDeviceAssignments';
import { useBusinesses } from '@/hooks/useBusinesses';

const mockedAssignments = useDeviceAssignments as unknown as ReturnType<typeof vi.fn>;
const mockedBusinesses = useBusinesses as unknown as ReturnType<typeof vi.fn>;

function makeAssignment(partial: Partial<DeviceAssignment>): DeviceAssignment {
  return {
    id: partial.id ?? 'a',
    organization_id: 'org-1',
    business_id: partial.business_id ?? null,
    scope_kind: partial.scope_kind ?? 'tenant',
    scope_id: partial.scope_id ?? null,
    role: partial.role ?? 'receipt_printer',
    transport: 'network',
    driver: 'escpos',
    display_name: 'Printer',
    config: {},
    capabilities: {},
    enabled: partial.enabled ?? true,
    is_default: partial.is_default ?? false,
    status: 'online',
    last_seen_at: null,
    last_error: null,
    source_config_id: null,
    created_at: '2026-01-01',
    updated_at: '2026-01-01',
  };
}

function setAssignments(rows: DeviceAssignment[]) {
  mockedAssignments.mockReturnValue({
    assignments: rows,
    byRole: new Map(),
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    upsert: { mutateAsync: vi.fn() },
    remove: { mutateAsync: vi.fn() },
  });
}

function setBusiness(id: string | null) {
  mockedBusinesses.mockReturnValue({ currentBusiness: id ? { id } : null });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useDeviceForRole — branch tie-break', () => {
  it('picks the assignment matching the active business when no is_default', () => {
    setAssignments([
      makeAssignment({ id: 'branch-a', business_id: 'biz-a' }),
      makeAssignment({ id: 'branch-b', business_id: 'biz-b' }),
    ]);
    setBusiness('biz-b');

    const { result } = renderHook(() => useDeviceForRole('receipt_printer'));
    expect(result.current.device?.id).toBe('branch-b');
  });

  it('falls back to is_default when no business assignment matches', () => {
    setAssignments([
      makeAssignment({ id: 'global-default', business_id: null, is_default: true }),
      makeAssignment({ id: 'other-branch', business_id: 'biz-other' }),
    ]);
    setBusiness('biz-unknown');

    const { result } = renderHook(() => useDeviceForRole('receipt_printer'));
    expect(result.current.device?.id).toBe('global-default');
  });

  it('honours an explicit scope above the business tie-break', () => {
    setAssignments([
      makeAssignment({ id: 'register-x', scope_kind: 'register', scope_id: 'reg-x', business_id: 'biz-a' }),
      makeAssignment({ id: 'branch-b', business_id: 'biz-b' }),
    ]);
    setBusiness('biz-b');

    const { result } = renderHook(() =>
      useDeviceForRole('receipt_printer', { scope: { kind: 'register', id: 'reg-x' } }),
    );
    expect(result.current.device?.id).toBe('register-x');
  });

  it('preferBusinessId: null disables the tie-break (returns pool[0])', () => {
    setAssignments([
      makeAssignment({ id: 'branch-a', business_id: 'biz-a' }),
      makeAssignment({ id: 'branch-b', business_id: 'biz-b' }),
    ]);
    setBusiness('biz-b');

    const { result } = renderHook(() =>
      useDeviceForRole('receipt_printer', { preferBusinessId: null }),
    );
    expect(result.current.device?.id).toBe('branch-a');
  });

  it('returns null for an empty pool', () => {
    setAssignments([]);
    setBusiness('biz-a');
    const { result } = renderHook(() => useDeviceForRole('receipt_printer'));
    expect(result.current.device).toBeNull();
  });
});
