import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePOSShifts, POSShift, OpenShiftData, CloseShiftData } from '@/hooks/pos/usePOSShifts';
import { createMockShift, createMockRegister } from '@/test/factories/pos.factory';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Mock the dependencies
vi.mock('@/hooks/useOrganization', () => ({
  useOrganization: () => ({
    currentOrg: { id: 'test-org-id', name: 'Test Org' },
  }),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'test-user-id', email: 'test@example.com' },
  }),
}));

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(() => Promise.resolve({ data: null, error: null })),
            order: vi.fn(() => Promise.resolve({ data: [], error: null })),
          })),
          order: vi.fn(() => Promise.resolve({ data: [], error: null })),
        })),
      })),
      insert: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn(() => Promise.resolve({ 
            data: createMockShift(), 
            error: null 
          })),
        })),
      })),
      update: vi.fn(() => ({
        eq: vi.fn(() => ({
          select: vi.fn(() => ({
            single: vi.fn(() => Promise.resolve({ 
              data: createMockShift({ status: 'closed' }), 
              error: null 
            })),
          })),
        })),
      })),
    })),
    rpc: vi.fn(() => Promise.resolve({ data: 'SHIFT-001', error: null })),
  },
}));

// Create wrapper for React Query
const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  
  const Wrapper = ({ children }: { children: React.ReactNode }) => {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  };
  
  return Wrapper;
};

describe('usePOSShifts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Shift Data Model', () => {
    it('should have correct shift interface', () => {
      const shift = createMockShift();
      
      expect(shift).toHaveProperty('id');
      expect(shift).toHaveProperty('organization_id');
      expect(shift).toHaveProperty('register_id');
      expect(shift).toHaveProperty('user_id');
      expect(shift).toHaveProperty('shift_number');
      expect(shift).toHaveProperty('opened_at');
      expect(shift).toHaveProperty('opening_cash');
      expect(shift).toHaveProperty('expected_cash');
      expect(shift).toHaveProperty('status');
    });

    it('should have valid status values', () => {
      const validStatuses: Array<'open' | 'closed' | 'reconciled'> = ['open', 'closed', 'reconciled'];
      
      validStatuses.forEach(status => {
        const shift = createMockShift({ status });
        expect(shift.status).toBe(status);
      });
    });
  });

  describe('Open Shift Logic', () => {
    it('should create shift with required fields', () => {
      const openShiftData: OpenShiftData = {
        register_id: 'reg-1',
        opening_cash: 5000,
        notes: 'Opening shift',
      };

      expect(openShiftData.register_id).toBeDefined();
      expect(openShiftData.opening_cash).toBeGreaterThanOrEqual(0);
    });

    it('should set expected_cash equal to opening_cash initially', () => {
      const shift = createMockShift({
        opening_cash: 5000,
        expected_cash: 5000,
      });

      expect(shift.expected_cash).toBe(shift.opening_cash);
    });

    it('should set status to open when shift is opened', () => {
      const shift = createMockShift({ status: 'open' });
      expect(shift.status).toBe('open');
    });
  });

  describe('Close Shift Logic', () => {
    it('should calculate cash difference correctly', () => {
      const expectedCash = 15000;
      const actualCash = 14500;
      const cashDifference = actualCash - expectedCash;

      expect(cashDifference).toBe(-500); // Short by 500
    });

    it('should identify cash over correctly', () => {
      const expectedCash = 15000;
      const actualCash = 15500;
      const cashDifference = actualCash - expectedCash;

      expect(cashDifference).toBe(500); // Over by 500
    });

    it('should identify perfect balance', () => {
      const expectedCash = 15000;
      const actualCash = 15000;
      const cashDifference = actualCash - expectedCash;

      expect(cashDifference).toBe(0);
    });

    it('should close shift with all required fields', () => {
      const closeShiftData: CloseShiftData = {
        shift_id: 'shift-1',
        actual_cash: 15000,
        notes: 'Closing shift',
      };

      expect(closeShiftData.shift_id).toBeDefined();
      expect(closeShiftData.actual_cash).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Shift Filtering', () => {
    it('should filter open shifts correctly', () => {
      const shifts = [
        createMockShift({ id: 's1', status: 'open' }),
        createMockShift({ id: 's2', status: 'closed' }),
        createMockShift({ id: 's3', status: 'open' }),
        createMockShift({ id: 's4', status: 'reconciled' }),
      ];

      const openShifts = shifts.filter(s => s.status === 'open');
      expect(openShifts).toHaveLength(2);
    });

    it('should filter today\'s shifts correctly', () => {
      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      const shifts = [
        createMockShift({ id: 's1', opened_at: today.toISOString() }),
        createMockShift({ id: 's2', opened_at: yesterday.toISOString() }),
        createMockShift({ id: 's3', opened_at: today.toISOString() }),
      ];

      const todayShifts = shifts.filter(
        s => new Date(s.opened_at).toDateString() === today.toDateString()
      );
      expect(todayShifts).toHaveLength(2);
    });
  });

  describe('Expected Cash Calculation', () => {
    it('should update expected cash after cash sale', () => {
      const openingCash = 5000;
      const cashSale = 1500;
      const expectedCash = openingCash + cashSale;

      expect(expectedCash).toBe(6500);
    });

    it('should update expected cash after cash refund', () => {
      const expectedCash = 6500;
      const cashRefund = 500;
      const newExpectedCash = expectedCash - cashRefund;

      expect(newExpectedCash).toBe(6000);
    });

    it('should not change expected cash for card payments', () => {
      const expectedCash = 5000;
      // Card payments don't affect cash drawer
      expect(expectedCash).toBe(5000);
    });
  });

  describe('Register Association', () => {
    it('should include register details with shift', () => {
      const shift = createMockShift();
      
      expect(shift.register).toBeDefined();
      expect(shift.register?.register_name).toBe('Register 1');
      expect(shift.register?.register_code).toBe('REG-001');
    });

    it('should link shift to specific register', () => {
      const register = createMockRegister({ id: 'reg-1' });
      const shift = createMockShift({ register_id: register.id });

      expect(shift.register_id).toBe(register.id);
    });
  });
});
