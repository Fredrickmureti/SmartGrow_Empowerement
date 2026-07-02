/**
 * MSW Handlers for POS Module
 * 
 * Comprehensive mock handlers for POS-related API endpoints.
 * Covers transactions, shifts, sessions, and RPC calls.
 */

import { http, HttpResponse } from 'msw';
import { createMockTransaction, createMockShift, createMockRegister } from '../../factories/pos.factory';

const SUPABASE_URL = 'https://jkszmrroyjfdwokbkzis.supabase.co';

// Track state for stateful tests
let transactionCounter = 0;
let shiftCounter = 0;

export const posHandlers = [
  // ============ POS TRANSACTIONS ============
  
  // Process transaction RPC
  http.post(`${SUPABASE_URL}/rest/v1/rpc/process_pos_transaction`, async ({ request }) => {
    const body = await request.json() as Record<string, unknown>;
    transactionCounter++;
    
    const transactionNumber = `POS1-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${String(transactionCounter).padStart(4, '0')}`;
    
    return HttpResponse.json({
      success: true,
      transaction_id: `txn-${transactionCounter}`,
      transaction_number: transactionNumber,
    });
  }),

  // Get transactions list
  http.get(`${SUPABASE_URL}/rest/v1/pos_transactions*`, ({ request }) => {
    const url = new URL(request.url);
    const shiftId = url.searchParams.get('shift_id');
    
    const transactions = [
      createMockTransaction({ shift_id: shiftId || 'shift-1' }),
      createMockTransaction({ shift_id: shiftId || 'shift-1', transaction_type: 'void' }),
    ];
    
    return HttpResponse.json(transactions);
  }),

  // Create transaction (direct insert)
  http.post(`${SUPABASE_URL}/rest/v1/pos_transactions`, async ({ request }) => {
    const body = await request.json() as Record<string, unknown>;
    transactionCounter++;
    
    return HttpResponse.json({
      id: `txn-${transactionCounter}`,
      transaction_number: `TXN-${String(transactionCounter).padStart(4, '0')}`,
      ...body,
      created_at: new Date().toISOString(),
    });
  }),

  // Update transaction (void, refund)
  http.patch(`${SUPABASE_URL}/rest/v1/pos_transactions*`, async ({ request }) => {
    const body = await request.json() as Record<string, unknown>;
    return HttpResponse.json({
      id: 'txn-1',
      ...body,
      updated_at: new Date().toISOString(),
    });
  }),

  // ============ POS SHIFTS ============

  // Get shifts
  http.get(`${SUPABASE_URL}/rest/v1/pos_shifts*`, ({ request }) => {
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    
    const shifts = [
      createMockShift({ status: status === 'eq.open' ? 'open' : 'closed' }),
    ];
    
    return HttpResponse.json(shifts);
  }),

  // Open shift
  http.post(`${SUPABASE_URL}/rest/v1/pos_shifts`, async ({ request }) => {
    const body = await request.json() as Record<string, unknown>;
    shiftCounter++;
    
    return HttpResponse.json({
      id: `shift-${shiftCounter}`,
      shift_number: `SH-REG1-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${String(shiftCounter).padStart(2, '0')}`,
      status: 'open',
      ...body,
      opened_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    });
  }),

  // Close/update shift
  http.patch(`${SUPABASE_URL}/rest/v1/pos_shifts*`, async ({ request }) => {
    const body = await request.json() as Record<string, unknown>;
    return HttpResponse.json({
      id: 'shift-1',
      ...body,
      closed_at: body.status === 'closed' ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    });
  }),

  // ============ POS REGISTERS ============

  http.get(`${SUPABASE_URL}/rest/v1/pos_registers*`, () => {
    return HttpResponse.json([
      createMockRegister(),
      createMockRegister({ register_code: 'REG-002', register_name: 'Register 2' }),
    ]);
  }),

  // ============ POS SESSIONS ============

  http.get(`${SUPABASE_URL}/rest/v1/pos_sessions*`, () => {
    return HttpResponse.json([
      {
        id: 'session-1',
        cashier_id: 'cashier-1',
        register_id: 'register-1',
        status: 'active',
        started_at: new Date().toISOString(),
      },
    ]);
  }),

  http.post(`${SUPABASE_URL}/rest/v1/pos_sessions`, async ({ request }) => {
    const body = await request.json() as Record<string, unknown>;
    return HttpResponse.json({
      id: 'session-new',
      status: 'active',
      ...body,
      started_at: new Date().toISOString(),
    });
  }),

  // ============ POS CASHIERS ============

  http.get(`${SUPABASE_URL}/rest/v1/pos_cashiers*`, () => {
    return HttpResponse.json([
      {
        id: 'cashier-1',
        name: 'John Doe',
        code: 'JD001',
        is_active: true,
      },
    ]);
  }),

  // Verify cashier PIN
  http.post(`${SUPABASE_URL}/rest/v1/rpc/verify_cashier_pin`, async ({ request }) => {
    const body = await request.json() as { p_pin?: string };
    // Accept PIN '1234' for testing
    const isValid = body.p_pin === '1234';
    return HttpResponse.json(isValid);
  }),

  // ============ POS TRANSACTION ITEMS ============

  http.post(`${SUPABASE_URL}/rest/v1/pos_transaction_items`, async ({ request }) => {
    const body = await request.json();
    return HttpResponse.json(body);
  }),

  http.get(`${SUPABASE_URL}/rest/v1/pos_transaction_items*`, () => {
    return HttpResponse.json([
      {
        id: 'item-1',
        transaction_id: 'txn-1',
        product_id: 'prod-1',
        quantity: 2,
        unit_price: 100,
        line_total: 200,
      },
    ]);
  }),

  // ============ POS TRANSACTION PAYMENTS ============

  http.post(`${SUPABASE_URL}/rest/v1/pos_transaction_payments`, async ({ request }) => {
    const body = await request.json();
    return HttpResponse.json(body);
  }),

  // ============ RPC CALLS ============

  http.post(`${SUPABASE_URL}/rest/v1/rpc/get_next_shift_number`, () => {
    shiftCounter++;
    return HttpResponse.json(`SH-REG1-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${String(shiftCounter).padStart(2, '0')}`);
  }),

  http.post(`${SUPABASE_URL}/rest/v1/rpc/get_next_pos_transaction_number`, () => {
    transactionCounter++;
    return HttpResponse.json(`POS1-${new Date().toISOString().slice(2, 10).replace(/-/g, '')}-${String(transactionCounter).padStart(4, '0')}`);
  }),

  http.post(`${SUPABASE_URL}/rest/v1/rpc/get_available_stock`, () => {
    return HttpResponse.json(100); // Always return 100 available
  }),

  // ============ HELD TRANSACTIONS ============

  http.get(`${SUPABASE_URL}/rest/v1/pos_held_transactions*`, () => {
    return HttpResponse.json([]);
  }),

  http.post(`${SUPABASE_URL}/rest/v1/pos_held_transactions`, async ({ request }) => {
    const body = await request.json() as Record<string, unknown>;
    return HttpResponse.json({
      id: 'held-1',
      ...body,
      created_at: new Date().toISOString(),
    });
  }),
];

// Reset counters between tests
export const resetPOSMockState = () => {
  transactionCounter = 0;
  shiftCounter = 0;
};

export default posHandlers;
