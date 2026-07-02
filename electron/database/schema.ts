/**
 * SQLite Schema for Offline POS Database
 * Uses Drizzle ORM for type-safe queries
 * Mirrors Supabase schema with sync metadata
 */

import { sqliteTable, text, real, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// ============ Reference/Cached Data Tables (Read-only, synced FROM server) ============

export const organizations = sqliteTable('organizations', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  currency: text('currency').default('KES'),
  tax_settings: text('tax_settings'), // JSON string
  receipt_settings: text('receipt_settings'), // JSON string
  synced_at: text('synced_at'),
  updated_at: text('updated_at'),
});

export const businesses = sqliteTable('businesses', {
  id: text('id').primaryKey(),
  organization_id: text('organization_id').notNull(),
  name: text('name').notNull(),
  legal_name: text('legal_name'),
  logo_url: text('logo_url'),
  address: text('address'),
  city: text('city'),
  country: text('country'),
  phone: text('phone'),
  email: text('email'),
  tax_id: text('tax_id'),
  registration_number: text('registration_number'),
  base_currency: text('base_currency').default('KES'),
  synced_at: text('synced_at'),
  updated_at: text('updated_at'),
});

export const branches = sqliteTable('branches', {
  id: text('id').primaryKey(),
  organization_id: text('organization_id').notNull(),
  business_id: text('business_id').notNull(),
  name: text('name').notNull(),
  code: text('code'),
  is_headquarters: integer('is_headquarters', { mode: 'boolean' }).default(false),
  address: text('address'),
  city: text('city'),
  state: text('state'),
  country: text('country'),
  phone: text('phone'),
  email: text('email'),
  postal_code: text('postal_code'),
  is_active: integer('is_active', { mode: 'boolean' }).default(true),
  synced_at: text('synced_at'),
  updated_at: text('updated_at'),
}, (table) => ({
  businessIdx: index('branches_business_idx').on(table.business_id),
  orgIdx: index('branches_org_idx').on(table.organization_id),
}));

export const userBranchAssignments = sqliteTable('user_branch_assignments', {
  id: text('id').primaryKey(),
  user_id: text('user_id').notNull(),
  organization_id: text('organization_id').notNull(),
  business_id: text('business_id').notNull(),
  branch_id: text('branch_id').notNull(),
  is_primary: integer('is_primary', { mode: 'boolean' }).default(false),
  can_view: integer('can_view', { mode: 'boolean' }).default(true),
  can_manage: integer('can_manage', { mode: 'boolean' }).default(false),
  synced_at: text('synced_at'),
  updated_at: text('updated_at'),
}, (table) => ({
  userIdx: index('branch_assignments_user_idx').on(table.user_id),
  branchIdx: index('branch_assignments_branch_idx').on(table.branch_id),
  businessIdx: index('branch_assignments_business_idx').on(table.business_id),
}));

export const products = sqliteTable('products', {
  id: text('id').primaryKey(),
  organization_id: text('organization_id').notNull(),
  business_id: text('business_id'),
  name: text('name').notNull(),
  sku: text('sku'),
  barcode: text('barcode'),
  description: text('description'),
  selling_price: real('selling_price').notNull().default(0),
  cost_price: real('cost_price').default(0),
  tax_rate: real('tax_rate').default(0),
  stock_quantity: real('stock_quantity').default(0),
  category: text('category'),
  image_url: text('image_url'),
  is_active: integer('is_active', { mode: 'boolean' }).default(true),
  track_inventory: integer('track_inventory', { mode: 'boolean' }).default(true),
  reorder_level: real('reorder_level').default(0),
  unit_of_measure: text('unit_of_measure').default('unit'),
  synced_at: text('synced_at'),
  updated_at: text('updated_at'),
}, (table) => ({
  skuIdx: index('products_sku_idx').on(table.sku),
  barcodeIdx: index('products_barcode_idx').on(table.barcode),
  categoryIdx: index('products_category_idx').on(table.category),
  orgIdx: index('products_org_idx').on(table.organization_id),
  businessIdx: index('products_business_idx').on(table.business_id),
}));

export const contacts = sqliteTable('contacts', {
  id: text('id').primaryKey(),
  organization_id: text('organization_id').notNull(),
  business_id: text('business_id'),
  name: text('name').notNull(),
  email: text('email'),
  phone: text('phone'),
  type: text('type').default('customer'), // customer, vendor, both
  company: text('company'),
  address_line1: text('address_line1'),
  address_line2: text('address_line2'),
  city: text('city'),
  country: text('country'),
  tax_id: text('tax_id'),
  notes: text('notes'),
  is_active: integer('is_active', { mode: 'boolean' }).default(true),
  synced_at: text('synced_at'),
  updated_at: text('updated_at'),
}, (table) => ({
  orgIdx: index('contacts_org_idx').on(table.organization_id),
  businessIdx: index('contacts_business_idx').on(table.business_id),
  typeIdx: index('contacts_type_idx').on(table.type),
  phoneIdx: index('contacts_phone_idx').on(table.phone),
}));

export const posRegisters = sqliteTable('pos_registers', {
  id: text('id').primaryKey(),
  organization_id: text('organization_id').notNull(),
  business_id: text('business_id'),
  branch_id: text('branch_id'),
  register_code: text('register_code').notNull(),
  name: text('name').notNull(),
  location: text('location'),
  is_active: integer('is_active', { mode: 'boolean' }).default(true),
  synced_at: text('synced_at'),
  updated_at: text('updated_at'),
});

export const posCashiers = sqliteTable('pos_cashiers', {
  id: text('id').primaryKey(),
  organization_id: text('organization_id').notNull(),
  user_id: text('user_id'),
  display_name: text('display_name').notNull(),
  employee_number: text('employee_number'),
  pin_hash: text('pin_hash'), // bcrypt hash
  permissions: text('permissions'), // JSON string
  is_active: integer('is_active', { mode: 'boolean' }).default(true),
  synced_at: text('synced_at'),
  updated_at: text('updated_at'),
});

export const taxRates = sqliteTable('tax_rates', {
  id: text('id').primaryKey(),
  organization_id: text('organization_id').notNull(),
  name: text('name').notNull(),
  rate: real('rate').notNull(),
  is_default: integer('is_default', { mode: 'boolean' }).default(false),
  is_active: integer('is_active', { mode: 'boolean' }).default(true),
  synced_at: text('synced_at'),
  updated_at: text('updated_at'),
});

export const posDiscounts = sqliteTable('pos_discounts', {
  id: text('id').primaryKey(),
  organization_id: text('organization_id').notNull(),
  name: text('name').notNull(),
  discount_type: text('discount_type').notNull(), // percentage, fixed
  value: real('value').notNull(),
  min_purchase: real('min_purchase'),
  is_active: integer('is_active', { mode: 'boolean' }).default(true),
  synced_at: text('synced_at'),
  updated_at: text('updated_at'),
});

// POS Settings - cached locally for offline receipt formatting
export const posSettings = sqliteTable('pos_settings', {
  id: text('id').primaryKey(),
  organization_id: text('organization_id').notNull(),
  register_id: text('register_id'),
  setting_key: text('setting_key').notNull(),
  setting_value: text('setting_value'), // JSON string or value
  synced_at: text('synced_at'),
  updated_at: text('updated_at'),
}, (table) => ({
  orgKeyIdx: index('pos_settings_org_key_idx').on(table.organization_id, table.setting_key),
}));

// Platform settings - cached locally for M-Pesa environment control, etc.
export const platformSettings = sqliteTable('platform_settings', {
  id: text('id').primaryKey(),
  setting_key: text('setting_key').notNull().unique(),
  setting_value: text('setting_value'),
  setting_type: text('setting_type'),
  description: text('description'),
  synced_at: text('synced_at'),
  updated_at: text('updated_at'),
});

export const loyaltyPrograms = sqliteTable('loyalty_programs', {
  id: text('id').primaryKey(),
  organization_id: text('organization_id').notNull(),
  name: text('name').notNull(),
  points_per_currency: real('points_per_currency').default(1),
  redemption_rate: real('redemption_rate').default(0.01),
  is_active: integer('is_active', { mode: 'boolean' }).default(true),
  synced_at: text('synced_at'),
  updated_at: text('updated_at'),
});

export const customerLoyalty = sqliteTable('customer_loyalty', {
  id: text('id').primaryKey(),
  contact_id: text('contact_id').notNull(),
  program_id: text('program_id').notNull(),
  points_balance: real('points_balance').default(0),
  points_earned_total: real('points_earned_total').default(0),
  points_redeemed_total: real('points_redeemed_total').default(0),
  total_spent: real('total_spent').default(0),
  visit_count: integer('visit_count').default(0),
  current_tier: text('current_tier'),
  synced_at: text('synced_at'),
  updated_at: text('updated_at'),
}, (table) => ({
  contactIdx: index('loyalty_contact_idx').on(table.contact_id),
}));

// ============ Notification Tables (Cached from server) ============

export const notifications = sqliteTable('notifications', {
  id: text('id').primaryKey(),
  organization_id: text('organization_id').notNull(),
  business_id: text('business_id'),
  user_id: text('user_id').notNull(),
  type: text('type').notNull(), // info, warning, error, success
  category: text('category').notNull(),
  title: text('title').notNull(),
  message: text('message').notNull(),
  link: text('link'),
  entity_type: text('entity_type'),
  entity_id: text('entity_id'),
  is_read: integer('is_read', { mode: 'boolean' }).default(false),
  is_dismissed: integer('is_dismissed', { mode: 'boolean' }).default(false),
  priority: integer('priority').default(0),
  expires_at: text('expires_at'),
  synced_at: text('synced_at'),
  created_at: text('created_at'),
  updated_at: text('updated_at'),
}, (table) => ({
  userIdx: index('notifications_user_idx').on(table.user_id),
  readIdx: index('notifications_read_idx').on(table.is_read),
  categoryIdx: index('notifications_category_idx').on(table.category),
}));

export const notificationPreferences = sqliteTable('notification_preferences', {
  id: text('id').primaryKey(),
  user_id: text('user_id').notNull(),
  organization_id: text('organization_id').notNull(),
  category: text('category').notNull(),
  email_enabled: integer('email_enabled', { mode: 'boolean' }).default(true),
  push_enabled: integer('push_enabled', { mode: 'boolean' }).default(true),
  in_app_enabled: integer('in_app_enabled', { mode: 'boolean' }).default(true),
  synced_at: text('synced_at'),
  updated_at: text('updated_at'),
}, (table) => ({
  userOrgIdx: index('notification_prefs_user_org_idx').on(table.user_id, table.organization_id),
}));

export const notificationAlertSettings = sqliteTable('notification_alert_settings', {
  id: text('id').primaryKey(),
  organization_id: text('organization_id').notNull(),
  business_id: text('business_id'),
  low_stock_warning_threshold: integer('low_stock_warning_threshold').default(10),
  low_stock_critical_threshold: integer('low_stock_critical_threshold').default(5),
  out_of_stock_alert: integer('out_of_stock_alert', { mode: 'boolean' }).default(true),
  invoice_reminder_days_before: integer('invoice_reminder_days_before').default(7),
  overdue_reminder_frequency_days: integer('overdue_reminder_frequency_days').default(7),
  daily_digest_enabled: integer('daily_digest_enabled', { mode: 'boolean' }).default(false),
  weekly_digest_enabled: integer('weekly_digest_enabled', { mode: 'boolean' }).default(true),
  synced_at: text('synced_at'),
  updated_at: text('updated_at'),
}, (table) => ({
  orgIdx: index('notification_alert_settings_org_idx').on(table.organization_id),
}));

// ============ Transaction Tables (Write-enabled, synced TO server) ============

export const posShifts = sqliteTable('pos_shifts', {
  id: text('id').primaryKey(),
  server_id: text('server_id'), // NULL until synced
  organization_id: text('organization_id').notNull(),
  business_id: text('business_id'),
  branch_id: text('branch_id'),
  register_id: text('register_id').notNull(),
  cashier_id: text('cashier_id').notNull(),
  shift_number: text('shift_number'),
  opening_cash: real('opening_cash').notNull().default(0),
  expected_cash: real('expected_cash').default(0),
  actual_cash: real('actual_cash'),
  variance: real('variance'),
  cash_sales: real('cash_sales').default(0),
  card_sales: real('card_sales').default(0),
  mpesa_sales: real('mpesa_sales').default(0),
  total_sales: real('total_sales').default(0),
  total_refunds: real('total_refunds').default(0),
  transaction_count: integer('transaction_count').default(0),
  opened_at: text('opened_at').notNull(),
  closed_at: text('closed_at'),
  notes: text('notes'),
  status: text('status').default('open'), // open, closed
  sync_status: text('sync_status').default('pending'), // pending, syncing, synced, failed, conflict
  synced_at: text('synced_at'),
  sync_error: text('sync_error'),
  local_version: integer('local_version').default(1),
  server_version: integer('server_version'),
  created_at: text('created_at').default(sql`(datetime('now'))`),
  updated_at: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  syncIdx: index('shifts_sync_idx').on(table.sync_status),
  dateIdx: index('shifts_date_idx').on(table.opened_at),
  businessIdx: index('shifts_business_idx').on(table.business_id),
}));

export const posTransactions = sqliteTable('pos_transactions', {
  id: text('id').primaryKey(),
  server_id: text('server_id'), // NULL until synced
  organization_id: text('organization_id').notNull(),
  business_id: text('business_id'),
  branch_id: text('branch_id'),
  transaction_number: text('transaction_number').notNull(),
  register_id: text('register_id'),
  shift_id: text('shift_id'),
  customer_id: text('customer_id'),
  subtotal: real('subtotal').notNull().default(0),
  tax_amount: real('tax_amount').default(0),
  discount_amount: real('discount_amount').default(0),
  discount_type: text('discount_type'),
  total: real('total').notNull().default(0),
  payment_status: text('payment_status').default('pending'), // pending, partial, paid
  status: text('status').default('completed'), // draft, completed, voided, refunded
  notes: text('notes'),
  // eTIMS fields
  etims_cu_number: text('etims_cu_number'),
  etims_qr_code_url: text('etims_qr_code_url'),
  etims_transmission_status: text('etims_transmission_status'),
  // Sync metadata
  sync_status: text('sync_status').default('pending'), // pending, syncing, synced, failed, conflict
  synced_at: text('synced_at'),
  sync_error: text('sync_error'),
  local_version: integer('local_version').default(1),
  server_version: integer('server_version'),
  // Timestamps
  created_at: text('created_at').default(sql`(datetime('now'))`),
  created_by: text('created_by'),
  updated_at: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  syncIdx: index('transactions_sync_idx').on(table.sync_status),
  dateIdx: index('transactions_date_idx').on(table.created_at),
  shiftIdx: index('transactions_shift_idx').on(table.shift_id),
  numberIdx: uniqueIndex('transactions_number_idx').on(table.transaction_number),
  businessIdx: index('transactions_business_idx').on(table.business_id),
}));

export const posTransactionItems = sqliteTable('pos_transaction_items', {
  id: text('id').primaryKey(),
  transaction_id: text('transaction_id').notNull(),
  product_id: text('product_id'),
  description: text('description').notNull(),
  quantity: real('quantity').notNull().default(1),
  unit_price: real('unit_price').notNull().default(0),
  discount_type: text('discount_type'),
  discount_value: real('discount_value').default(0),
  tax_rate: real('tax_rate').default(0),
  tax_amount: real('tax_amount').default(0),
  line_total: real('line_total').notNull().default(0),
  cost_price: real('cost_price'),
  sort_order: integer('sort_order').default(0),
  created_at: text('created_at').default(sql`(datetime('now'))`),
}, (table) => ({
  transactionIdx: index('items_transaction_idx').on(table.transaction_id),
}));

export const posTransactionPayments = sqliteTable('pos_transaction_payments', {
  id: text('id').primaryKey(),
  transaction_id: text('transaction_id').notNull(),
  payment_method: text('payment_method').notNull(), // cash, card, mpesa, credit
  amount: real('amount').notNull().default(0),
  reference: text('reference'),
  mpesa_receipt: text('mpesa_receipt'),
  change_given: real('change_given').default(0),
  status: text('status').default('completed'), // pending, completed, failed
  created_at: text('created_at').default(sql`(datetime('now'))`),
}, (table) => ({
  transactionIdx: index('payments_transaction_idx').on(table.transaction_id),
}));

export const posCashMovements = sqliteTable('pos_cash_movements', {
  id: text('id').primaryKey(),
  server_id: text('server_id'),
  organization_id: text('organization_id').notNull(),
  shift_id: text('shift_id').notNull(),
  movement_type: text('movement_type').notNull(), // cash_in, cash_out, drop, pickup
  amount: real('amount').notNull(),
  reason: text('reason'),
  notes: text('notes'),
  performed_by: text('performed_by'),
  performed_at: text('performed_at').default(sql`(datetime('now'))`),
  sync_status: text('sync_status').default('pending'),
  synced_at: text('synced_at'),
  sync_error: text('sync_error'),
}, (table) => ({
  shiftIdx: index('movements_shift_idx').on(table.shift_id),
  syncIdx: index('movements_sync_idx').on(table.sync_status),
}));

export const posReturns = sqliteTable('pos_returns', {
  id: text('id').primaryKey(),
  server_id: text('server_id'),
  organization_id: text('organization_id').notNull(),
  original_transaction_id: text('original_transaction_id').notNull(),
  return_number: text('return_number').notNull(),
  reason: text('reason').notNull(),
  refund_method: text('refund_method'), // cash, card, mpesa, store_credit
  refund_amount: real('refund_amount').notNull(),
  status: text('status').default('completed'),
  processed_by: text('processed_by'),
  approved_by: text('approved_by'),
  sync_status: text('sync_status').default('pending'),
  synced_at: text('synced_at'),
  sync_error: text('sync_error'),
  created_at: text('created_at').default(sql`(datetime('now'))`),
}, (table) => ({
  syncIdx: index('returns_sync_idx').on(table.sync_status),
  originalTxIdx: index('returns_original_tx_idx').on(table.original_transaction_id),
}));

export const posReturnItems = sqliteTable('pos_return_items', {
  id: text('id').primaryKey(),
  return_id: text('return_id').notNull(),
  original_item_id: text('original_item_id'),
  product_id: text('product_id'),
  description: text('description').notNull(),
  quantity: real('quantity').notNull(),
  unit_price: real('unit_price').notNull(),
  refund_amount: real('refund_amount').notNull(),
  restock: integer('restock', { mode: 'boolean' }).default(true),
  created_at: text('created_at').default(sql`(datetime('now'))`),
}, (table) => ({
  returnIdx: index('return_items_return_idx').on(table.return_id),
}));

// ============ Stock Movement Tracking ============

export const stockMovements = sqliteTable('stock_movements', {
  id: text('id').primaryKey(),
  server_id: text('server_id'),
  organization_id: text('organization_id').notNull(),
  product_id: text('product_id').notNull(),
  movement_type: text('movement_type').notNull(), // sale, return, adjustment, transfer
  quantity: real('quantity').notNull(),
  reference_type: text('reference_type'), // pos_transaction, pos_return, manual
  reference_id: text('reference_id'),
  notes: text('notes'),
  performed_by: text('performed_by'),
  sync_status: text('sync_status').default('pending'),
  synced_at: text('synced_at'),
  created_at: text('created_at').default(sql`(datetime('now'))`),
}, (table) => ({
  productIdx: index('stock_product_idx').on(table.product_id),
  syncIdx: index('stock_sync_idx').on(table.sync_status),
}));

// ============ Sync Metadata ============

export const syncMetadata = sqliteTable('sync_metadata', {
  table_name: text('table_name').primaryKey(),
  last_synced_at: text('last_synced_at'),
  last_server_timestamp: text('last_server_timestamp'),
  records_synced: integer('records_synced').default(0),
  sync_direction: text('sync_direction').notNull(), // down, up, both
});

// ============ Offline Authentication ============

export const offlineSessions = sqliteTable('offline_sessions', {
  id: text('id').primaryKey(),
  user_id: text('user_id').notNull(),
  email: text('email').notNull(),
  password_hash: text('password_hash').notNull(), // bcrypt hash for offline verification
  session_token_encrypted: text('session_token_encrypted'), // Encrypted JWT for when back online
  organization_id: text('organization_id').notNull(),
  user_role: text('user_role'),
  full_name: text('full_name'),
  expires_at: text('expires_at').notNull(),
  created_at: text('created_at').default(sql`(datetime('now'))`),
  updated_at: text('updated_at').default(sql`(datetime('now'))`),
}, (table) => ({
  emailIdx: uniqueIndex('sessions_email_idx').on(table.email),
  userIdx: index('sessions_user_idx').on(table.user_id),
}));

// ============ Held Transactions (Not yet completed) ============

export const heldTransactions = sqliteTable('held_transactions', {
  id: text('id').primaryKey(),
  organization_id: text('organization_id').notNull(),
  register_id: text('register_id'),
  shift_id: text('shift_id'),
  customer_id: text('customer_id'),
  customer_name: text('customer_name'),
  items: text('items').notNull(), // JSON string of cart items
  subtotal: real('subtotal').default(0),
  tax_amount: real('tax_amount').default(0),
  discount_amount: real('discount_amount').default(0),
  total: real('total').default(0),
  notes: text('notes'),
  held_by: text('held_by'),
  held_at: text('held_at').default(sql`(datetime('now'))`),
  expires_at: text('expires_at'),
});

// ============ Audit Log ============

export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey(),
  organization_id: text('organization_id').notNull(),
  action: text('action').notNull(), // create, update, delete, void, sync
  table_name: text('table_name').notNull(),
  record_id: text('record_id'),
  old_data: text('old_data'), // JSON string
  new_data: text('new_data'), // JSON string
  user_id: text('user_id'),
  user_email: text('user_email'),
  ip_address: text('ip_address'),
  user_agent: text('user_agent'),
  is_synced: integer('is_synced', { mode: 'boolean' }).default(false),
  created_at: text('created_at').default(sql`(datetime('now'))`),
}, (table) => ({
  dateIdx: index('audit_date_idx').on(table.created_at),
  syncIdx: index('audit_sync_idx').on(table.is_synced),
  tableIdx: index('audit_table_idx').on(table.table_name),
}));

// ============ Settings Cache ============

export const settingsCache = sqliteTable('settings_cache', {
  key: text('key').primaryKey(),
  value: text('value').notNull(), // JSON string
  synced_at: text('synced_at'),
});

// Type exports for use in application
export type Organization = typeof organizations.$inferSelect;
export type Business = typeof businesses.$inferSelect;
export type Product = typeof products.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type PosRegister = typeof posRegisters.$inferSelect;
export type PosCashier = typeof posCashiers.$inferSelect;
export type TaxRate = typeof taxRates.$inferSelect;
export type PosDiscount = typeof posDiscounts.$inferSelect;
export type LoyaltyProgram = typeof loyaltyPrograms.$inferSelect;
export type CustomerLoyalty = typeof customerLoyalty.$inferSelect;
export type PosShift = typeof posShifts.$inferSelect;
export type PosTransaction = typeof posTransactions.$inferSelect;
export type PosTransactionItem = typeof posTransactionItems.$inferSelect;
export type PosTransactionPayment = typeof posTransactionPayments.$inferSelect;
export type PosCashMovement = typeof posCashMovements.$inferSelect;
export type PosReturn = typeof posReturns.$inferSelect;
export type PosReturnItem = typeof posReturnItems.$inferSelect;
export type StockMovement = typeof stockMovements.$inferSelect;
export type SyncMetadata = typeof syncMetadata.$inferSelect;
export type OfflineSession = typeof offlineSessions.$inferSelect;
export type HeldTransaction = typeof heldTransactions.$inferSelect;
export type AuditLogEntry = typeof auditLog.$inferSelect;
export type SettingsCache = typeof settingsCache.$inferSelect;
export type Branch = typeof branches.$inferSelect;
export type UserBranchAssignment = typeof userBranchAssignments.$inferSelect;

// ============ Hardware Orchestration (Phase 3) ============

/**
 * Durable per-device command queue. Every `pos:exec` invocation is
 * recorded here and survives renderer crashes. Idempotency is enforced
 * by the unique `idempotency_key`. See ADR-0014 and
 * `electron/hardware/CommandQueue.ts`.
 */
export const hwCommandQueue = sqliteTable('hw_command_queue', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  device_role: text('device_role').notNull(),
  op: text('op').notNull(),
  payload: text('payload').notNull(),          // JSON
  status: text('status').notNull().default('pending'), // pending|running|done|failed|dead
  attempts: integer('attempts').notNull().default(0),
  max_attempts: integer('max_attempts').notNull().default(5),
  last_error: text('last_error'),
  idempotency_key: text('idempotency_key').notNull(),
  result: text('result'),                      // JSON
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
}, (table) => ({
  roleStatusIdx: index('hw_queue_role_status_idx').on(table.device_role, table.status),
  idemUnique: uniqueIndex('hw_queue_idem_unique').on(table.idempotency_key),
}));

/**
 * Sale-completion saga outbox. One row per (sale_id, step). Replayed on
 * app start by `SaleSaga.replayUnfinished` so a mid-sale crash doesn't
 * lose a receipt or skip the drawer kick.
 */
export const posOutbox = sqliteTable('pos_outbox', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sale_id: text('sale_id').notNull(),
  step: text('step').notNull(),                // print_receipt|open_drawer|update_display|post_gl
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  last_error: text('last_error'),
  created_at: integer('created_at').notNull(),
}, (table) => ({
  saleStepUnique: uniqueIndex('pos_outbox_sale_step_unique').on(table.sale_id, table.step),
  statusIdx: index('pos_outbox_status_idx').on(table.status),
}));

/**
 * Persistent sale commit payloads for crash recovery (ADR-0014 Track H3b).
 * Without this, a main-process crash would leave the outbox rows but lose
 * the receipt/drawer/display/gl payloads needed to re-issue saga steps.
 */
export const posSalePayloads = sqliteTable('pos_sale_payloads', {
  sale_id: text('sale_id').primaryKey(),
  payload_json: text('payload_json').notNull(),
  created_at: integer('created_at').notNull(),
});

// Insert types
export type NewPosTransaction = typeof posTransactions.$inferInsert;
export type NewPosTransactionItem = typeof posTransactionItems.$inferInsert;
export type NewPosTransactionPayment = typeof posTransactionPayments.$inferInsert;
export type NewPosShift = typeof posShifts.$inferInsert;
export type NewPosCashMovement = typeof posCashMovements.$inferInsert;
export type NewPosReturn = typeof posReturns.$inferInsert;
export type NewStockMovement = typeof stockMovements.$inferInsert;
export type NewAuditLogEntry = typeof auditLog.$inferInsert;
export type NewHwCommandQueue = typeof hwCommandQueue.$inferInsert;
export type NewPosOutbox = typeof posOutbox.$inferInsert;

// ============ Payment Terminal FSM log (ADR-0014 Track P) ============

/**
 * Per-transaction journal for the payment-terminal FSM. Idempotency is
 * enforced by `idempotency_key` UNIQUE — repeat charges of the same key
 * resolve to the cached terminal result. SettlementReconciler walks
 * `state='approved' AND auto_capture=1 AND updated_at < cutoff`.
 */
export const posPaymentTerminalLog = sqliteTable('pos_payment_terminal_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  txn_id: text('txn_id').notNull(),
  pos_order_id: text('pos_order_id'),
  vendor: text('vendor').notNull(),
  state: text('state').notNull(),
  amount_cents: integer('amount_cents').notNull(),
  currency: text('currency').notNull(),
  auth_id: text('auth_id'),
  vendor_txn_id: text('vendor_txn_id'),
  idempotency_key: text('idempotency_key').notNull(),
  error: text('error'),
  auto_capture: integer('auto_capture').notNull().default(1),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
}, (table) => ({
  idemUnique: uniqueIndex('pos_pt_log_idem_unique').on(table.idempotency_key),
  stateIdx: index('pos_pt_log_state_idx').on(table.state, table.updated_at),
  authIdx: index('pos_pt_log_auth_idx').on(table.auth_id),
}));

// ============ Bluetooth pairings (ADR-0014 Track B) ============

/**
 * Persistent Bluetooth pairings keyed by logical device id. Link keys
 * are sealed with KeyManager AES-256-GCM (machine + user-password
 * binding) so an attacker with raw SQLite access cannot replay them.
 */
export const btPairings = sqliteTable('bt_pairings', {
  device_id: text('device_id').primaryKey(),
  mac: text('mac').notNull(),
  name: text('name'),
  role: text('role').notNull(),
  link_key_encrypted: text('link_key_encrypted'),
  auto_reconnect: integer('auto_reconnect').notNull().default(1),
  paired_at: integer('paired_at').notNull(),
  last_connected_at: integer('last_connected_at'),
});

export type NewPosPaymentTerminalLog = typeof posPaymentTerminalLog.$inferInsert;
export type NewBtPairing = typeof btPairings.$inferInsert;

