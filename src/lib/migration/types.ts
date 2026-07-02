export type MigrationStatus = 'draft' | 'in_progress' | 'validating' | 'completed' | 'failed' | 'rolled_back';
export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'skipped' | 'failed';
export type MigrationStrategy = 'summary' | 'full_transaction';

export type StepKey =
  | 'config'
  | 'accounts'
  | 'contacts'
  | 'products'
  | 'trial_balance'
  | 'open_ar'
  | 'open_ap'
  | 'payments'
  | 'bank_balances'
  | 'inventory'
  | 'validation'
  | 'finalization';

export interface MigrationSession {
  id: string;
  organization_id: string;
  business_id: string | null;
  status: MigrationStatus;
  migration_strategy: MigrationStrategy;
  cutover_date: string | null;
  source_system: string | null;
  notes: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface MigrationStep {
  id: string;
  session_id: string;
  step_key: StepKey;
  step_order: number;
  status: StepStatus;
  record_count: number;
  error_count: number;
  error_log: any[];
  started_at: string | null;
  completed_at: string | null;
}

export interface MigrationBatch {
  id: string;
  session_id: string;
  step_key: string;
  batch_hash: string;
  source_file_name: string | null;
  records_total: number;
  records_imported: number;
  records_failed: number;
  error_details: any[];
  created_at: string;
}

/** Steps that create rollback-able records */
export type RollbackableStepKey = 'trial_balance' | 'open_ar' | 'open_ap' | 'payments' | 'bank_balances' | 'inventory';

/** Describes what a rollback operation should clean up */
export interface RollbackManifest {
  stepKey: RollbackableStepKey;
  /** Delete invoices with this migration_session_id */
  deleteInvoices?: boolean;
  /** Delete bills with this migration_session_id */
  deleteBills?: boolean;
  /** Delete payments linked to migrated invoices */
  deletePayments?: boolean;
  /** Delete stock_movements with this migration_session_id */
  deleteStockMovements?: boolean;
  /** Delete journal entries with source_type='migration' and matching source_id prefix */
  deleteJournalEntries?: boolean;
  /** Reset accounts.opening_balance to 0 for affected accounts */
  resetOpeningBalances?: boolean;
  /** Reset bank_accounts.opening_balance and current_balance to 0 */
  resetBankBalances?: boolean;
}

/** Map of which step creates which records */
export const STEP_ROLLBACK_CONFIG: Record<RollbackableStepKey, RollbackManifest> = {
  trial_balance: {
    stepKey: 'trial_balance',
    deleteJournalEntries: true,
    resetOpeningBalances: true,
  },
  open_ar: {
    stepKey: 'open_ar',
    deleteInvoices: true,
    deleteJournalEntries: true,
  },
  open_ap: {
    stepKey: 'open_ap',
    deleteBills: true,
    deleteJournalEntries: true,
  },
  payments: {
    stepKey: 'payments' as RollbackableStepKey,
    deletePayments: true,
    deleteJournalEntries: true,
  },
  bank_balances: {
    stepKey: 'bank_balances',
    resetBankBalances: true,
  },
  inventory: {
    stepKey: 'inventory',
    deleteStockMovements: true,
  },
};

export const MIGRATION_STEPS_CONFIG: { key: StepKey; order: number; label: string; description: string; prerequisites: StepKey[] }[] = [
  { key: 'config', order: 1, label: 'System Configuration', description: 'Verify organization, currency, and fiscal year settings', prerequisites: [] },
  { key: 'accounts', order: 2, label: 'Chart of Accounts', description: 'Import or verify your chart of accounts', prerequisites: ['config'] },
  { key: 'contacts', order: 3, label: 'Contacts', description: 'Import customers and suppliers', prerequisites: ['accounts'] },
  { key: 'products', order: 4, label: 'Products & Items', description: 'Import products with inventory and account linkage', prerequisites: ['accounts'] },
  { key: 'trial_balance', order: 5, label: 'Trial Balance', description: 'Import opening balances and generate Opening Balance journal entry', prerequisites: ['accounts'] },
  { key: 'open_ar', order: 6, label: 'Open Receivables (AR)', description: 'Import open customer invoices (subledger detail only — GL is posted via Trial Balance)', prerequisites: ['contacts', 'trial_balance'] },
  { key: 'open_ap', order: 7, label: 'Open Payables (AP)', description: 'Import open supplier bills (subledger detail only — GL is posted via Trial Balance)', prerequisites: ['contacts', 'trial_balance'] },
  { key: 'payments', order: 8, label: 'Payment Import', description: 'Import customer payments and link to migrated invoices (full transaction mode only)', prerequisites: ['open_ar'] },
  { key: 'bank_balances', order: 9, label: 'Bank Balances', description: 'Set bank account opening balances', prerequisites: ['trial_balance'] },
  { key: 'inventory', order: 10, label: 'Inventory', description: 'Import opening stock quantities and values (subledger detail only)', prerequisites: ['products', 'trial_balance'] },
  { key: 'validation', order: 11, label: 'Validation', description: 'Cross-check all imported balances for consistency', prerequisites: ['trial_balance'] },
  { key: 'finalization', order: 12, label: 'Finalize Migration', description: 'Lock cutover date and complete migration', prerequisites: ['validation'] },
];
