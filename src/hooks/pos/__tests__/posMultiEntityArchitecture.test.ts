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
    expect(creditSale).toContain('invoiceBranchId');
    expect(invoiceRequest).toContain('(txn as any).branch_id');
  });

  it('offline transaction replay carries business and branch scope', () => {
    const queue = read('src/services/offline/TransactionQueue.ts');
    const hook = read('src/hooks/pos/usePOSTransactionOffline.ts');
    expect(queue).toContain('business_id: string');
    expect(queue).toContain('branch_id: string');
    expect(queue).toContain('p_business_id: data.business_id');
    expect(hook).toContain('branch_id: branchId');
  });
});
