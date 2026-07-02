import { describe, it, expect } from 'vitest';
import { STEP_TO_ROLE_OP } from '../../../electron/hardware/SaleSaga';

describe('SaleSaga routing (Track P)', () => {
  it('post_gl no longer routes through the payment_terminal role', () => {
    expect(STEP_TO_ROLE_OP.post_gl.role).toBe('saga');
    expect(STEP_TO_ROLE_OP.post_gl.op).toBe('post_gl');
  });

  it('every other step maps to its physical-device role', () => {
    expect(STEP_TO_ROLE_OP.print_receipt.role).toBe('receipt_printer');
    expect(STEP_TO_ROLE_OP.open_drawer.role).toBe('cash_drawer');
    expect(STEP_TO_ROLE_OP.update_display.role).toBe('customer_display');
  });
});