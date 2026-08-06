import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('POS multi-entity architecture guards', () => {
  it('terminal sessions never insert blank business context', () => {
    const source = read('src/hooks/pos/usePOSSessionsOffline.ts');
    expect(source).not.toContain("business_id: ''");
    expect(source).toContain('business_id: context.business_id');
    expect(source).toContain('branch_id: context.branch_id');
  });

  it('POS invoices use transaction lineage instead of active UI branch', () => {
    const creditSale = read('src/hooks/pos/usePOSCreditSale.ts');
    const invoiceRequest = read('src/hooks/pos/usePOSInvoiceRequest.ts');
    expect(creditSale).not.toContain('currentBranch');
    expect(invoiceRequest).not.toContain('currentBranch');
    // ADR 0128 — branch (and business) lineage is resolved server-side from
    // the POS transaction row inside `create_pos_credit_sale_invoice_atomic`,
    // so neither hook may derive the invoice's branch on the client.
    expect(creditSale).toContain('create_pos_credit_sale_invoice_atomic');
    expect(invoiceRequest).toContain('create_pos_credit_sale_invoice_atomic');
  });

  it('offline transaction replay carries business and branch scope', () => {
    const queue = read('src/services/offline/TransactionQueue.ts');
    const hook = read('src/hooks/pos/usePOSTransactionOffline.ts');
    expect(queue).toContain('business_id: string');
    expect(queue).toContain('branch_id: string');
    // Replay goes through the payment-session lifecycle, which resolves
    // business/branch from the register server-side and collapses retries.
    expect(queue).toContain('registerId: data.register_id');
    expect(queue).toContain('idempotencyKey: queued.id');
    expect(hook).toContain('branch_id: branchId');
  });
});

