"use strict";
/**
 * SQLite Schema for Offline POS Database
 * Uses Drizzle ORM for type-safe queries
 * Mirrors Supabase schema with sync metadata
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.btPairings = exports.posPaymentTerminalLog = exports.posSalePayloads = exports.posOutbox = exports.hwCommandQueue = exports.settingsCache = exports.auditLog = exports.heldTransactions = exports.offlineSessions = exports.syncMetadata = exports.stockMovements = exports.posReturnItems = exports.posReturns = exports.posCashMovements = exports.posTransactionPayments = exports.posTransactionItems = exports.posTransactions = exports.posShifts = exports.notificationAlertSettings = exports.notificationPreferences = exports.notifications = exports.customerLoyalty = exports.loyaltyPrograms = exports.platformSettings = exports.posSettings = exports.posDiscounts = exports.taxRates = exports.posCashiers = exports.posRegisters = exports.contacts = exports.products = exports.userBranchAssignments = exports.branches = exports.businesses = exports.organizations = void 0;
const sqlite_core_1 = require("drizzle-orm/sqlite-core");
const drizzle_orm_1 = require("drizzle-orm");
// ============ Reference/Cached Data Tables (Read-only, synced FROM server) ============
exports.organizations = (0, sqlite_core_1.sqliteTable)('organizations', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    name: (0, sqlite_core_1.text)('name').notNull(),
    currency: (0, sqlite_core_1.text)('currency').default('KES'),
    tax_settings: (0, sqlite_core_1.text)('tax_settings'), // JSON string
    receipt_settings: (0, sqlite_core_1.text)('receipt_settings'), // JSON string
    synced_at: (0, sqlite_core_1.text)('synced_at'),
    updated_at: (0, sqlite_core_1.text)('updated_at'),
});
exports.businesses = (0, sqlite_core_1.sqliteTable)('businesses', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    organization_id: (0, sqlite_core_1.text)('organization_id').notNull(),
    name: (0, sqlite_core_1.text)('name').notNull(),
    legal_name: (0, sqlite_core_1.text)('legal_name'),
    logo_url: (0, sqlite_core_1.text)('logo_url'),
    address: (0, sqlite_core_1.text)('address'),
    city: (0, sqlite_core_1.text)('city'),
    country: (0, sqlite_core_1.text)('country'),
    phone: (0, sqlite_core_1.text)('phone'),
    email: (0, sqlite_core_1.text)('email'),
    tax_id: (0, sqlite_core_1.text)('tax_id'),
    registration_number: (0, sqlite_core_1.text)('registration_number'),
    base_currency: (0, sqlite_core_1.text)('base_currency').default('KES'),
    synced_at: (0, sqlite_core_1.text)('synced_at'),
    updated_at: (0, sqlite_core_1.text)('updated_at'),
});
exports.branches = (0, sqlite_core_1.sqliteTable)('branches', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    organization_id: (0, sqlite_core_1.text)('organization_id').notNull(),
    business_id: (0, sqlite_core_1.text)('business_id').notNull(),
    name: (0, sqlite_core_1.text)('name').notNull(),
    code: (0, sqlite_core_1.text)('code'),
    is_headquarters: (0, sqlite_core_1.integer)('is_headquarters', { mode: 'boolean' }).default(false),
    address: (0, sqlite_core_1.text)('address'),
    city: (0, sqlite_core_1.text)('city'),
    state: (0, sqlite_core_1.text)('state'),
    country: (0, sqlite_core_1.text)('country'),
    phone: (0, sqlite_core_1.text)('phone'),
    email: (0, sqlite_core_1.text)('email'),
    postal_code: (0, sqlite_core_1.text)('postal_code'),
    is_active: (0, sqlite_core_1.integer)('is_active', { mode: 'boolean' }).default(true),
    synced_at: (0, sqlite_core_1.text)('synced_at'),
    updated_at: (0, sqlite_core_1.text)('updated_at'),
}, (table) => ({
    businessIdx: (0, sqlite_core_1.index)('branches_business_idx').on(table.business_id),
    orgIdx: (0, sqlite_core_1.index)('branches_org_idx').on(table.organization_id),
}));
exports.userBranchAssignments = (0, sqlite_core_1.sqliteTable)('user_branch_assignments', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    user_id: (0, sqlite_core_1.text)('user_id').notNull(),
    organization_id: (0, sqlite_core_1.text)('organization_id').notNull(),
    business_id: (0, sqlite_core_1.text)('business_id').notNull(),
    branch_id: (0, sqlite_core_1.text)('branch_id').notNull(),
    is_primary: (0, sqlite_core_1.integer)('is_primary', { mode: 'boolean' }).default(false),
    can_view: (0, sqlite_core_1.integer)('can_view', { mode: 'boolean' }).default(true),
    can_manage: (0, sqlite_core_1.integer)('can_manage', { mode: 'boolean' }).default(false),
    synced_at: (0, sqlite_core_1.text)('synced_at'),
    updated_at: (0, sqlite_core_1.text)('updated_at'),
}, (table) => ({
    userIdx: (0, sqlite_core_1.index)('branch_assignments_user_idx').on(table.user_id),
    branchIdx: (0, sqlite_core_1.index)('branch_assignments_branch_idx').on(table.branch_id),
    businessIdx: (0, sqlite_core_1.index)('branch_assignments_business_idx').on(table.business_id),
}));
exports.products = (0, sqlite_core_1.sqliteTable)('products', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    organization_id: (0, sqlite_core_1.text)('organization_id').notNull(),
    business_id: (0, sqlite_core_1.text)('business_id'),
    name: (0, sqlite_core_1.text)('name').notNull(),
    sku: (0, sqlite_core_1.text)('sku'),
    barcode: (0, sqlite_core_1.text)('barcode'),
    description: (0, sqlite_core_1.text)('description'),
    selling_price: (0, sqlite_core_1.real)('selling_price').notNull().default(0),
    cost_price: (0, sqlite_core_1.real)('cost_price').default(0),
    tax_rate: (0, sqlite_core_1.real)('tax_rate').default(0),
    stock_quantity: (0, sqlite_core_1.real)('stock_quantity').default(0),
    category: (0, sqlite_core_1.text)('category'),
    image_url: (0, sqlite_core_1.text)('image_url'),
    is_active: (0, sqlite_core_1.integer)('is_active', { mode: 'boolean' }).default(true),
    track_inventory: (0, sqlite_core_1.integer)('track_inventory', { mode: 'boolean' }).default(true),
    reorder_level: (0, sqlite_core_1.real)('reorder_level').default(0),
    unit_of_measure: (0, sqlite_core_1.text)('unit_of_measure').default('unit'),
    synced_at: (0, sqlite_core_1.text)('synced_at'),
    updated_at: (0, sqlite_core_1.text)('updated_at'),
}, (table) => ({
    skuIdx: (0, sqlite_core_1.index)('products_sku_idx').on(table.sku),
    barcodeIdx: (0, sqlite_core_1.index)('products_barcode_idx').on(table.barcode),
    categoryIdx: (0, sqlite_core_1.index)('products_category_idx').on(table.category),
    orgIdx: (0, sqlite_core_1.index)('products_org_idx').on(table.organization_id),
    businessIdx: (0, sqlite_core_1.index)('products_business_idx').on(table.business_id),
}));
exports.contacts = (0, sqlite_core_1.sqliteTable)('contacts', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    organization_id: (0, sqlite_core_1.text)('organization_id').notNull(),
    business_id: (0, sqlite_core_1.text)('business_id'),
    name: (0, sqlite_core_1.text)('name').notNull(),
    email: (0, sqlite_core_1.text)('email'),
    phone: (0, sqlite_core_1.text)('phone'),
    type: (0, sqlite_core_1.text)('type').default('customer'), // customer, vendor, both
    company: (0, sqlite_core_1.text)('company'),
    address_line1: (0, sqlite_core_1.text)('address_line1'),
    address_line2: (0, sqlite_core_1.text)('address_line2'),
    city: (0, sqlite_core_1.text)('city'),
    country: (0, sqlite_core_1.text)('country'),
    tax_id: (0, sqlite_core_1.text)('tax_id'),
    notes: (0, sqlite_core_1.text)('notes'),
    is_active: (0, sqlite_core_1.integer)('is_active', { mode: 'boolean' }).default(true),
    synced_at: (0, sqlite_core_1.text)('synced_at'),
    updated_at: (0, sqlite_core_1.text)('updated_at'),
}, (table) => ({
    orgIdx: (0, sqlite_core_1.index)('contacts_org_idx').on(table.organization_id),
    businessIdx: (0, sqlite_core_1.index)('contacts_business_idx').on(table.business_id),
    typeIdx: (0, sqlite_core_1.index)('contacts_type_idx').on(table.type),
    phoneIdx: (0, sqlite_core_1.index)('contacts_phone_idx').on(table.phone),
}));
exports.posRegisters = (0, sqlite_core_1.sqliteTable)('pos_registers', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    organization_id: (0, sqlite_core_1.text)('organization_id').notNull(),
    business_id: (0, sqlite_core_1.text)('business_id'),
    branch_id: (0, sqlite_core_1.text)('branch_id'),
    register_code: (0, sqlite_core_1.text)('register_code').notNull(),
    name: (0, sqlite_core_1.text)('name').notNull(),
    location: (0, sqlite_core_1.text)('location'),
    is_active: (0, sqlite_core_1.integer)('is_active', { mode: 'boolean' }).default(true),
    synced_at: (0, sqlite_core_1.text)('synced_at'),
    updated_at: (0, sqlite_core_1.text)('updated_at'),
});
exports.posCashiers = (0, sqlite_core_1.sqliteTable)('pos_cashiers', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    organization_id: (0, sqlite_core_1.text)('organization_id').notNull(),
    user_id: (0, sqlite_core_1.text)('user_id'),
    display_name: (0, sqlite_core_1.text)('display_name').notNull(),
    employee_number: (0, sqlite_core_1.text)('employee_number'),
    pin_hash: (0, sqlite_core_1.text)('pin_hash'), // bcrypt hash
    permissions: (0, sqlite_core_1.text)('permissions'), // JSON string
    is_active: (0, sqlite_core_1.integer)('is_active', { mode: 'boolean' }).default(true),
    synced_at: (0, sqlite_core_1.text)('synced_at'),
    updated_at: (0, sqlite_core_1.text)('updated_at'),
});
exports.taxRates = (0, sqlite_core_1.sqliteTable)('tax_rates', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    organization_id: (0, sqlite_core_1.text)('organization_id').notNull(),
    name: (0, sqlite_core_1.text)('name').notNull(),
    rate: (0, sqlite_core_1.real)('rate').notNull(),
    is_default: (0, sqlite_core_1.integer)('is_default', { mode: 'boolean' }).default(false),
    is_active: (0, sqlite_core_1.integer)('is_active', { mode: 'boolean' }).default(true),
    synced_at: (0, sqlite_core_1.text)('synced_at'),
    updated_at: (0, sqlite_core_1.text)('updated_at'),
});
exports.posDiscounts = (0, sqlite_core_1.sqliteTable)('pos_discounts', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    organization_id: (0, sqlite_core_1.text)('organization_id').notNull(),
    name: (0, sqlite_core_1.text)('name').notNull(),
    discount_type: (0, sqlite_core_1.text)('discount_type').notNull(), // percentage, fixed
    value: (0, sqlite_core_1.real)('value').notNull(),
    min_purchase: (0, sqlite_core_1.real)('min_purchase'),
    is_active: (0, sqlite_core_1.integer)('is_active', { mode: 'boolean' }).default(true),
    synced_at: (0, sqlite_core_1.text)('synced_at'),
    updated_at: (0, sqlite_core_1.text)('updated_at'),
});
// POS Settings - cached locally for offline receipt formatting
exports.posSettings = (0, sqlite_core_1.sqliteTable)('pos_settings', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    organization_id: (0, sqlite_core_1.text)('organization_id').notNull(),
    register_id: (0, sqlite_core_1.text)('register_id'),
    setting_key: (0, sqlite_core_1.text)('setting_key').notNull(),
    setting_value: (0, sqlite_core_1.text)('setting_value'), // JSON string or value
    synced_at: (0, sqlite_core_1.text)('synced_at'),
    updated_at: (0, sqlite_core_1.text)('updated_at'),
}, (table) => ({
    orgKeyIdx: (0, sqlite_core_1.index)('pos_settings_org_key_idx').on(table.organization_id, table.setting_key),
}));
// Platform settings - cached locally for M-Pesa environment control, etc.
exports.platformSettings = (0, sqlite_core_1.sqliteTable)('platform_settings', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    setting_key: (0, sqlite_core_1.text)('setting_key').notNull().unique(),
    setting_value: (0, sqlite_core_1.text)('setting_value'),
    setting_type: (0, sqlite_core_1.text)('setting_type'),
    description: (0, sqlite_core_1.text)('description'),
    synced_at: (0, sqlite_core_1.text)('synced_at'),
    updated_at: (0, sqlite_core_1.text)('updated_at'),
});
exports.loyaltyPrograms = (0, sqlite_core_1.sqliteTable)('loyalty_programs', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    organization_id: (0, sqlite_core_1.text)('organization_id').notNull(),
    name: (0, sqlite_core_1.text)('name').notNull(),
    points_per_currency: (0, sqlite_core_1.real)('points_per_currency').default(1),
    redemption_rate: (0, sqlite_core_1.real)('redemption_rate').default(0.01),
    is_active: (0, sqlite_core_1.integer)('is_active', { mode: 'boolean' }).default(true),
    synced_at: (0, sqlite_core_1.text)('synced_at'),
    updated_at: (0, sqlite_core_1.text)('updated_at'),
});
exports.customerLoyalty = (0, sqlite_core_1.sqliteTable)('customer_loyalty', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    contact_id: (0, sqlite_core_1.text)('contact_id').notNull(),
    program_id: (0, sqlite_core_1.text)('program_id').notNull(),
    points_balance: (0, sqlite_core_1.real)('points_balance').default(0),
    points_earned_total: (0, sqlite_core_1.real)('points_earned_total').default(0),
    points_redeemed_total: (0, sqlite_core_1.real)('points_redeemed_total').default(0),
    total_spent: (0, sqlite_core_1.real)('total_spent').default(0),
    visit_count: (0, sqlite_core_1.integer)('visit_count').default(0),
    current_tier: (0, sqlite_core_1.text)('current_tier'),
    synced_at: (0, sqlite_core_1.text)('synced_at'),
    updated_at: (0, sqlite_core_1.text)('updated_at'),
}, (table) => ({
    contactIdx: (0, sqlite_core_1.index)('loyalty_contact_idx').on(table.contact_id),
}));
// ============ Notification Tables (Cached from server) ============
exports.notifications = (0, sqlite_core_1.sqliteTable)('notifications', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    organization_id: (0, sqlite_core_1.text)('organization_id').notNull(),
    business_id: (0, sqlite_core_1.text)('business_id'),
    user_id: (0, sqlite_core_1.text)('user_id').notNull(),
    type: (0, sqlite_core_1.text)('type').notNull(), // info, warning, error, success
    category: (0, sqlite_core_1.text)('category').notNull(),
    title: (0, sqlite_core_1.text)('title').notNull(),
    message: (0, sqlite_core_1.text)('message').notNull(),
    link: (0, sqlite_core_1.text)('link'),
    entity_type: (0, sqlite_core_1.text)('entity_type'),
    entity_id: (0, sqlite_core_1.text)('entity_id'),
    is_read: (0, sqlite_core_1.integer)('is_read', { mode: 'boolean' }).default(false),
    is_dismissed: (0, sqlite_core_1.integer)('is_dismissed', { mode: 'boolean' }).default(false),
    priority: (0, sqlite_core_1.integer)('priority').default(0),
    expires_at: (0, sqlite_core_1.text)('expires_at'),
    synced_at: (0, sqlite_core_1.text)('synced_at'),
    created_at: (0, sqlite_core_1.text)('created_at'),
    updated_at: (0, sqlite_core_1.text)('updated_at'),
}, (table) => ({
    userIdx: (0, sqlite_core_1.index)('notifications_user_idx').on(table.user_id),
    readIdx: (0, sqlite_core_1.index)('notifications_read_idx').on(table.is_read),
    categoryIdx: (0, sqlite_core_1.index)('notifications_category_idx').on(table.category),
}));
exports.notificationPreferences = (0, sqlite_core_1.sqliteTable)('notification_preferences', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    user_id: (0, sqlite_core_1.text)('user_id').notNull(),
    organization_id: (0, sqlite_core_1.text)('organization_id').notNull(),
    category: (0, sqlite_core_1.text)('category').notNull(),
    email_enabled: (0, sqlite_core_1.integer)('email_enabled', { mode: 'boolean' }).default(true),
    push_enabled: (0, sqlite_core_1.integer)('push_enabled', { mode: 'boolean' }).default(true),
    in_app_enabled: (0, sqlite_core_1.integer)('in_app_enabled', { mode: 'boolean' }).default(true),
    synced_at: (0, sqlite_core_1.text)('synced_at'),
    updated_at: (0, sqlite_core_1.text)('updated_at'),
}, (table) => ({
    userOrgIdx: (0, sqlite_core_1.index)('notification_prefs_user_org_idx').on(table.user_id, table.organization_id),
}));
exports.notificationAlertSettings = (0, sqlite_core_1.sqliteTable)('notification_alert_settings', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    organization_id: (0, sqlite_core_1.text)('organization_id').notNull(),
    business_id: (0, sqlite_core_1.text)('business_id'),
    low_stock_warning_threshold: (0, sqlite_core_1.integer)('low_stock_warning_threshold').default(10),
    low_stock_critical_threshold: (0, sqlite_core_1.integer)('low_stock_critical_threshold').default(5),
    out_of_stock_alert: (0, sqlite_core_1.integer)('out_of_stock_alert', { mode: 'boolean' }).default(true),
    invoice_reminder_days_before: (0, sqlite_core_1.integer)('invoice_reminder_days_before').default(7),
    overdue_reminder_frequency_days: (0, sqlite_core_1.integer)('overdue_reminder_frequency_days').default(7),
    daily_digest_enabled: (0, sqlite_core_1.integer)('daily_digest_enabled', { mode: 'boolean' }).default(false),
    weekly_digest_enabled: (0, sqlite_core_1.integer)('weekly_digest_enabled', { mode: 'boolean' }).default(true),
    synced_at: (0, sqlite_core_1.text)('synced_at'),
    updated_at: (0, sqlite_core_1.text)('updated_at'),
}, (table) => ({
    orgIdx: (0, sqlite_core_1.index)('notification_alert_settings_org_idx').on(table.organization_id),
}));
// ============ Transaction Tables (Write-enabled, synced TO server) ============
exports.posShifts = (0, sqlite_core_1.sqliteTable)('pos_shifts', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    server_id: (0, sqlite_core_1.text)('server_id'), // NULL until synced
    organization_id: (0, sqlite_core_1.text)('organization_id').notNull(),
    business_id: (0, sqlite_core_1.text)('business_id'),
    branch_id: (0, sqlite_core_1.text)('branch_id'),
    register_id: (0, sqlite_core_1.text)('register_id').notNull(),
    cashier_id: (0, sqlite_core_1.text)('cashier_id').notNull(),
    shift_number: (0, sqlite_core_1.text)('shift_number'),
    opening_cash: (0, sqlite_core_1.real)('opening_cash').notNull().default(0),
    expected_cash: (0, sqlite_core_1.real)('expected_cash').default(0),
    actual_cash: (0, sqlite_core_1.real)('actual_cash'),
    variance: (0, sqlite_core_1.real)('variance'),
    cash_sales: (0, sqlite_core_1.real)('cash_sales').default(0),
    card_sales: (0, sqlite_core_1.real)('card_sales').default(0),
    mpesa_sales: (0, sqlite_core_1.real)('mpesa_sales').default(0),
    total_sales: (0, sqlite_core_1.real)('total_sales').default(0),
    total_refunds: (0, sqlite_core_1.real)('total_refunds').default(0),
    transaction_count: (0, sqlite_core_1.integer)('transaction_count').default(0),
    opened_at: (0, sqlite_core_1.text)('opened_at').notNull(),
    closed_at: (0, sqlite_core_1.text)('closed_at'),
    notes: (0, sqlite_core_1.text)('notes'),
    status: (0, sqlite_core_1.text)('status').default('open'), // open, closed
    sync_status: (0, sqlite_core_1.text)('sync_status').default('pending'), // pending, syncing, synced, failed, conflict
    synced_at: (0, sqlite_core_1.text)('synced_at'),
    sync_error: (0, sqlite_core_1.text)('sync_error'),
    local_version: (0, sqlite_core_1.integer)('local_version').default(1),
    server_version: (0, sqlite_core_1.integer)('server_version'),
    created_at: (0, sqlite_core_1.text)('created_at').default((0, drizzle_orm_1.sql) `(datetime('now'))`),
    updated_at: (0, sqlite_core_1.text)('updated_at').default((0, drizzle_orm_1.sql) `(datetime('now'))`),
}, (table) => ({
    syncIdx: (0, sqlite_core_1.index)('shifts_sync_idx').on(table.sync_status),
    dateIdx: (0, sqlite_core_1.index)('shifts_date_idx').on(table.opened_at),
    businessIdx: (0, sqlite_core_1.index)('shifts_business_idx').on(table.business_id),
}));
exports.posTransactions = (0, sqlite_core_1.sqliteTable)('pos_transactions', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    server_id: (0, sqlite_core_1.text)('server_id'), // NULL until synced
    organization_id: (0, sqlite_core_1.text)('organization_id').notNull(),
    business_id: (0, sqlite_core_1.text)('business_id'),
    branch_id: (0, sqlite_core_1.text)('branch_id'),
    transaction_number: (0, sqlite_core_1.text)('transaction_number').notNull(),
    register_id: (0, sqlite_core_1.text)('register_id'),
    shift_id: (0, sqlite_core_1.text)('shift_id'),
    customer_id: (0, sqlite_core_1.text)('customer_id'),
    subtotal: (0, sqlite_core_1.real)('subtotal').notNull().default(0),
    tax_amount: (0, sqlite_core_1.real)('tax_amount').default(0),
    discount_amount: (0, sqlite_core_1.real)('discount_amount').default(0),
    discount_type: (0, sqlite_core_1.text)('discount_type'),
    total: (0, sqlite_core_1.real)('total').notNull().default(0),
    payment_status: (0, sqlite_core_1.text)('payment_status').default('pending'), // pending, partial, paid
    status: (0, sqlite_core_1.text)('status').default('completed'), // draft, completed, voided, refunded
    notes: (0, sqlite_core_1.text)('notes'),
    // eTIMS fields
    etims_cu_number: (0, sqlite_core_1.text)('etims_cu_number'),
    etims_qr_code_url: (0, sqlite_core_1.text)('etims_qr_code_url'),
    etims_transmission_status: (0, sqlite_core_1.text)('etims_transmission_status'),
    // Sync metadata
    sync_status: (0, sqlite_core_1.text)('sync_status').default('pending'), // pending, syncing, synced, failed, conflict
    synced_at: (0, sqlite_core_1.text)('synced_at'),
    sync_error: (0, sqlite_core_1.text)('sync_error'),
    local_version: (0, sqlite_core_1.integer)('local_version').default(1),
    server_version: (0, sqlite_core_1.integer)('server_version'),
    // Timestamps
    created_at: (0, sqlite_core_1.text)('created_at').default((0, drizzle_orm_1.sql) `(datetime('now'))`),
    created_by: (0, sqlite_core_1.text)('created_by'),
    updated_at: (0, sqlite_core_1.text)('updated_at').default((0, drizzle_orm_1.sql) `(datetime('now'))`),
}, (table) => ({
    syncIdx: (0, sqlite_core_1.index)('transactions_sync_idx').on(table.sync_status),
    dateIdx: (0, sqlite_core_1.index)('transactions_date_idx').on(table.created_at),
    shiftIdx: (0, sqlite_core_1.index)('transactions_shift_idx').on(table.shift_id),
    numberIdx: (0, sqlite_core_1.uniqueIndex)('transactions_number_idx').on(table.transaction_number),
    businessIdx: (0, sqlite_core_1.index)('transactions_business_idx').on(table.business_id),
}));
exports.posTransactionItems = (0, sqlite_core_1.sqliteTable)('pos_transaction_items', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    transaction_id: (0, sqlite_core_1.text)('transaction_id').notNull(),
    product_id: (0, sqlite_core_1.text)('product_id'),
    description: (0, sqlite_core_1.text)('description').notNull(),
    quantity: (0, sqlite_core_1.real)('quantity').notNull().default(1),
    unit_price: (0, sqlite_core_1.real)('unit_price').notNull().default(0),
    discount_type: (0, sqlite_core_1.text)('discount_type'),
    discount_value: (0, sqlite_core_1.real)('discount_value').default(0),
    tax_rate: (0, sqlite_core_1.real)('tax_rate').default(0),
    tax_amount: (0, sqlite_core_1.real)('tax_amount').default(0),
    line_total: (0, sqlite_core_1.real)('line_total').notNull().default(0),
    cost_price: (0, sqlite_core_1.real)('cost_price'),
    sort_order: (0, sqlite_core_1.integer)('sort_order').default(0),
    created_at: (0, sqlite_core_1.text)('created_at').default((0, drizzle_orm_1.sql) `(datetime('now'))`),
}, (table) => ({
    transactionIdx: (0, sqlite_core_1.index)('items_transaction_idx').on(table.transaction_id),
}));
exports.posTransactionPayments = (0, sqlite_core_1.sqliteTable)('pos_transaction_payments', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    transaction_id: (0, sqlite_core_1.text)('transaction_id').notNull(),
    payment_method: (0, sqlite_core_1.text)('payment_method').notNull(), // cash, card, mpesa, credit
    amount: (0, sqlite_core_1.real)('amount').notNull().default(0),
    reference: (0, sqlite_core_1.text)('reference'),
    mpesa_receipt: (0, sqlite_core_1.text)('mpesa_receipt'),
    change_given: (0, sqlite_core_1.real)('change_given').default(0),
    status: (0, sqlite_core_1.text)('status').default('completed'), // pending, completed, failed
    created_at: (0, sqlite_core_1.text)('created_at').default((0, drizzle_orm_1.sql) `(datetime('now'))`),
}, (table) => ({
    transactionIdx: (0, sqlite_core_1.index)('payments_transaction_idx').on(table.transaction_id),
}));
exports.posCashMovements = (0, sqlite_core_1.sqliteTable)('pos_cash_movements', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    server_id: (0, sqlite_core_1.text)('server_id'),
    organization_id: (0, sqlite_core_1.text)('organization_id').notNull(),
    shift_id: (0, sqlite_core_1.text)('shift_id').notNull(),
    movement_type: (0, sqlite_core_1.text)('movement_type').notNull(), // cash_in, cash_out, drop, pickup
    amount: (0, sqlite_core_1.real)('amount').notNull(),
    reason: (0, sqlite_core_1.text)('reason'),
    notes: (0, sqlite_core_1.text)('notes'),
    performed_by: (0, sqlite_core_1.text)('performed_by'),
    performed_at: (0, sqlite_core_1.text)('performed_at').default((0, drizzle_orm_1.sql) `(datetime('now'))`),
    sync_status: (0, sqlite_core_1.text)('sync_status').default('pending'),
    synced_at: (0, sqlite_core_1.text)('synced_at'),
    sync_error: (0, sqlite_core_1.text)('sync_error'),
}, (table) => ({
    shiftIdx: (0, sqlite_core_1.index)('movements_shift_idx').on(table.shift_id),
    syncIdx: (0, sqlite_core_1.index)('movements_sync_idx').on(table.sync_status),
}));
exports.posReturns = (0, sqlite_core_1.sqliteTable)('pos_returns', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    server_id: (0, sqlite_core_1.text)('server_id'),
    organization_id: (0, sqlite_core_1.text)('organization_id').notNull(),
    original_transaction_id: (0, sqlite_core_1.text)('original_transaction_id').notNull(),
    return_number: (0, sqlite_core_1.text)('return_number').notNull(),
    reason: (0, sqlite_core_1.text)('reason').notNull(),
    refund_method: (0, sqlite_core_1.text)('refund_method'), // cash, card, mpesa, store_credit
    refund_amount: (0, sqlite_core_1.real)('refund_amount').notNull(),
    status: (0, sqlite_core_1.text)('status').default('completed'),
    processed_by: (0, sqlite_core_1.text)('processed_by'),
    approved_by: (0, sqlite_core_1.text)('approved_by'),
    sync_status: (0, sqlite_core_1.text)('sync_status').default('pending'),
    synced_at: (0, sqlite_core_1.text)('synced_at'),
    sync_error: (0, sqlite_core_1.text)('sync_error'),
    created_at: (0, sqlite_core_1.text)('created_at').default((0, drizzle_orm_1.sql) `(datetime('now'))`),
}, (table) => ({
    syncIdx: (0, sqlite_core_1.index)('returns_sync_idx').on(table.sync_status),
    originalTxIdx: (0, sqlite_core_1.index)('returns_original_tx_idx').on(table.original_transaction_id),
}));
exports.posReturnItems = (0, sqlite_core_1.sqliteTable)('pos_return_items', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    return_id: (0, sqlite_core_1.text)('return_id').notNull(),
    original_item_id: (0, sqlite_core_1.text)('original_item_id'),
    product_id: (0, sqlite_core_1.text)('product_id'),
    description: (0, sqlite_core_1.text)('description').notNull(),
    quantity: (0, sqlite_core_1.real)('quantity').notNull(),
    unit_price: (0, sqlite_core_1.real)('unit_price').notNull(),
    refund_amount: (0, sqlite_core_1.real)('refund_amount').notNull(),
    restock: (0, sqlite_core_1.integer)('restock', { mode: 'boolean' }).default(true),
    created_at: (0, sqlite_core_1.text)('created_at').default((0, drizzle_orm_1.sql) `(datetime('now'))`),
}, (table) => ({
    returnIdx: (0, sqlite_core_1.index)('return_items_return_idx').on(table.return_id),
}));
// ============ Stock Movement Tracking ============
exports.stockMovements = (0, sqlite_core_1.sqliteTable)('stock_movements', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    server_id: (0, sqlite_core_1.text)('server_id'),
    organization_id: (0, sqlite_core_1.text)('organization_id').notNull(),
    product_id: (0, sqlite_core_1.text)('product_id').notNull(),
    movement_type: (0, sqlite_core_1.text)('movement_type').notNull(), // sale, return, adjustment, transfer
    quantity: (0, sqlite_core_1.real)('quantity').notNull(),
    reference_type: (0, sqlite_core_1.text)('reference_type'), // pos_transaction, pos_return, manual
    reference_id: (0, sqlite_core_1.text)('reference_id'),
    notes: (0, sqlite_core_1.text)('notes'),
    performed_by: (0, sqlite_core_1.text)('performed_by'),
    sync_status: (0, sqlite_core_1.text)('sync_status').default('pending'),
    synced_at: (0, sqlite_core_1.text)('synced_at'),
    created_at: (0, sqlite_core_1.text)('created_at').default((0, drizzle_orm_1.sql) `(datetime('now'))`),
}, (table) => ({
    productIdx: (0, sqlite_core_1.index)('stock_product_idx').on(table.product_id),
    syncIdx: (0, sqlite_core_1.index)('stock_sync_idx').on(table.sync_status),
}));
// ============ Sync Metadata ============
exports.syncMetadata = (0, sqlite_core_1.sqliteTable)('sync_metadata', {
    table_name: (0, sqlite_core_1.text)('table_name').primaryKey(),
    last_synced_at: (0, sqlite_core_1.text)('last_synced_at'),
    last_server_timestamp: (0, sqlite_core_1.text)('last_server_timestamp'),
    records_synced: (0, sqlite_core_1.integer)('records_synced').default(0),
    sync_direction: (0, sqlite_core_1.text)('sync_direction').notNull(), // down, up, both
});
// ============ Offline Authentication ============
exports.offlineSessions = (0, sqlite_core_1.sqliteTable)('offline_sessions', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    user_id: (0, sqlite_core_1.text)('user_id').notNull(),
    email: (0, sqlite_core_1.text)('email').notNull(),
    password_hash: (0, sqlite_core_1.text)('password_hash').notNull(), // bcrypt hash for offline verification
    session_token_encrypted: (0, sqlite_core_1.text)('session_token_encrypted'), // Encrypted JWT for when back online
    organization_id: (0, sqlite_core_1.text)('organization_id').notNull(),
    user_role: (0, sqlite_core_1.text)('user_role'),
    full_name: (0, sqlite_core_1.text)('full_name'),
    expires_at: (0, sqlite_core_1.text)('expires_at').notNull(),
    created_at: (0, sqlite_core_1.text)('created_at').default((0, drizzle_orm_1.sql) `(datetime('now'))`),
    updated_at: (0, sqlite_core_1.text)('updated_at').default((0, drizzle_orm_1.sql) `(datetime('now'))`),
}, (table) => ({
    emailIdx: (0, sqlite_core_1.uniqueIndex)('sessions_email_idx').on(table.email),
    userIdx: (0, sqlite_core_1.index)('sessions_user_idx').on(table.user_id),
}));
// ============ Held Transactions (Not yet completed) ============
exports.heldTransactions = (0, sqlite_core_1.sqliteTable)('held_transactions', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    organization_id: (0, sqlite_core_1.text)('organization_id').notNull(),
    register_id: (0, sqlite_core_1.text)('register_id'),
    shift_id: (0, sqlite_core_1.text)('shift_id'),
    customer_id: (0, sqlite_core_1.text)('customer_id'),
    customer_name: (0, sqlite_core_1.text)('customer_name'),
    items: (0, sqlite_core_1.text)('items').notNull(), // JSON string of cart items
    subtotal: (0, sqlite_core_1.real)('subtotal').default(0),
    tax_amount: (0, sqlite_core_1.real)('tax_amount').default(0),
    discount_amount: (0, sqlite_core_1.real)('discount_amount').default(0),
    total: (0, sqlite_core_1.real)('total').default(0),
    notes: (0, sqlite_core_1.text)('notes'),
    held_by: (0, sqlite_core_1.text)('held_by'),
    held_at: (0, sqlite_core_1.text)('held_at').default((0, drizzle_orm_1.sql) `(datetime('now'))`),
    expires_at: (0, sqlite_core_1.text)('expires_at'),
});
// ============ Audit Log ============
exports.auditLog = (0, sqlite_core_1.sqliteTable)('audit_log', {
    id: (0, sqlite_core_1.text)('id').primaryKey(),
    organization_id: (0, sqlite_core_1.text)('organization_id').notNull(),
    action: (0, sqlite_core_1.text)('action').notNull(), // create, update, delete, void, sync
    table_name: (0, sqlite_core_1.text)('table_name').notNull(),
    record_id: (0, sqlite_core_1.text)('record_id'),
    old_data: (0, sqlite_core_1.text)('old_data'), // JSON string
    new_data: (0, sqlite_core_1.text)('new_data'), // JSON string
    user_id: (0, sqlite_core_1.text)('user_id'),
    user_email: (0, sqlite_core_1.text)('user_email'),
    ip_address: (0, sqlite_core_1.text)('ip_address'),
    user_agent: (0, sqlite_core_1.text)('user_agent'),
    is_synced: (0, sqlite_core_1.integer)('is_synced', { mode: 'boolean' }).default(false),
    created_at: (0, sqlite_core_1.text)('created_at').default((0, drizzle_orm_1.sql) `(datetime('now'))`),
}, (table) => ({
    dateIdx: (0, sqlite_core_1.index)('audit_date_idx').on(table.created_at),
    syncIdx: (0, sqlite_core_1.index)('audit_sync_idx').on(table.is_synced),
    tableIdx: (0, sqlite_core_1.index)('audit_table_idx').on(table.table_name),
}));
// ============ Settings Cache ============
exports.settingsCache = (0, sqlite_core_1.sqliteTable)('settings_cache', {
    key: (0, sqlite_core_1.text)('key').primaryKey(),
    value: (0, sqlite_core_1.text)('value').notNull(), // JSON string
    synced_at: (0, sqlite_core_1.text)('synced_at'),
});
// ============ Hardware Orchestration (Phase 3) ============
/**
 * Durable per-device command queue. Every `pos:exec` invocation is
 * recorded here and survives renderer crashes. Idempotency is enforced
 * by the unique `idempotency_key`. See ADR-0014 and
 * `electron/hardware/CommandQueue.ts`.
 */
exports.hwCommandQueue = (0, sqlite_core_1.sqliteTable)('hw_command_queue', {
    id: (0, sqlite_core_1.integer)('id').primaryKey({ autoIncrement: true }),
    device_role: (0, sqlite_core_1.text)('device_role').notNull(),
    op: (0, sqlite_core_1.text)('op').notNull(),
    payload: (0, sqlite_core_1.text)('payload').notNull(), // JSON
    status: (0, sqlite_core_1.text)('status').notNull().default('pending'), // pending|running|done|failed|dead
    attempts: (0, sqlite_core_1.integer)('attempts').notNull().default(0),
    max_attempts: (0, sqlite_core_1.integer)('max_attempts').notNull().default(5),
    last_error: (0, sqlite_core_1.text)('last_error'),
    idempotency_key: (0, sqlite_core_1.text)('idempotency_key').notNull(),
    result: (0, sqlite_core_1.text)('result'), // JSON
    created_at: (0, sqlite_core_1.integer)('created_at').notNull(),
    updated_at: (0, sqlite_core_1.integer)('updated_at').notNull(),
}, (table) => ({
    roleStatusIdx: (0, sqlite_core_1.index)('hw_queue_role_status_idx').on(table.device_role, table.status),
    idemUnique: (0, sqlite_core_1.uniqueIndex)('hw_queue_idem_unique').on(table.idempotency_key),
}));
/**
 * Sale-completion saga outbox. One row per (sale_id, step). Replayed on
 * app start by `SaleSaga.replayUnfinished` so a mid-sale crash doesn't
 * lose a receipt or skip the drawer kick.
 */
exports.posOutbox = (0, sqlite_core_1.sqliteTable)('pos_outbox', {
    id: (0, sqlite_core_1.integer)('id').primaryKey({ autoIncrement: true }),
    sale_id: (0, sqlite_core_1.text)('sale_id').notNull(),
    step: (0, sqlite_core_1.text)('step').notNull(), // print_receipt|open_drawer|update_display|post_gl
    status: (0, sqlite_core_1.text)('status').notNull().default('pending'),
    attempts: (0, sqlite_core_1.integer)('attempts').notNull().default(0),
    last_error: (0, sqlite_core_1.text)('last_error'),
    created_at: (0, sqlite_core_1.integer)('created_at').notNull(),
}, (table) => ({
    saleStepUnique: (0, sqlite_core_1.uniqueIndex)('pos_outbox_sale_step_unique').on(table.sale_id, table.step),
    statusIdx: (0, sqlite_core_1.index)('pos_outbox_status_idx').on(table.status),
}));
/**
 * Persistent sale commit payloads for crash recovery (ADR-0014 Track H3b).
 * Without this, a main-process crash would leave the outbox rows but lose
 * the receipt/drawer/display/gl payloads needed to re-issue saga steps.
 */
exports.posSalePayloads = (0, sqlite_core_1.sqliteTable)('pos_sale_payloads', {
    sale_id: (0, sqlite_core_1.text)('sale_id').primaryKey(),
    payload_json: (0, sqlite_core_1.text)('payload_json').notNull(),
    created_at: (0, sqlite_core_1.integer)('created_at').notNull(),
});
// ============ Payment Terminal FSM log (ADR-0014 Track P) ============
/**
 * Per-transaction journal for the payment-terminal FSM. Idempotency is
 * enforced by `idempotency_key` UNIQUE — repeat charges of the same key
 * resolve to the cached terminal result. SettlementReconciler walks
 * `state='approved' AND auto_capture=1 AND updated_at < cutoff`.
 */
exports.posPaymentTerminalLog = (0, sqlite_core_1.sqliteTable)('pos_payment_terminal_log', {
    id: (0, sqlite_core_1.integer)('id').primaryKey({ autoIncrement: true }),
    txn_id: (0, sqlite_core_1.text)('txn_id').notNull(),
    pos_order_id: (0, sqlite_core_1.text)('pos_order_id'),
    vendor: (0, sqlite_core_1.text)('vendor').notNull(),
    state: (0, sqlite_core_1.text)('state').notNull(),
    amount_cents: (0, sqlite_core_1.integer)('amount_cents').notNull(),
    currency: (0, sqlite_core_1.text)('currency').notNull(),
    auth_id: (0, sqlite_core_1.text)('auth_id'),
    vendor_txn_id: (0, sqlite_core_1.text)('vendor_txn_id'),
    idempotency_key: (0, sqlite_core_1.text)('idempotency_key').notNull(),
    error: (0, sqlite_core_1.text)('error'),
    auto_capture: (0, sqlite_core_1.integer)('auto_capture').notNull().default(1),
    created_at: (0, sqlite_core_1.integer)('created_at').notNull(),
    updated_at: (0, sqlite_core_1.integer)('updated_at').notNull(),
}, (table) => ({
    idemUnique: (0, sqlite_core_1.uniqueIndex)('pos_pt_log_idem_unique').on(table.idempotency_key),
    stateIdx: (0, sqlite_core_1.index)('pos_pt_log_state_idx').on(table.state, table.updated_at),
    authIdx: (0, sqlite_core_1.index)('pos_pt_log_auth_idx').on(table.auth_id),
}));
// ============ Bluetooth pairings (ADR-0014 Track B) ============
/**
 * Persistent Bluetooth pairings keyed by logical device id. Link keys
 * are sealed with KeyManager AES-256-GCM (machine + user-password
 * binding) so an attacker with raw SQLite access cannot replay them.
 */
exports.btPairings = (0, sqlite_core_1.sqliteTable)('bt_pairings', {
    device_id: (0, sqlite_core_1.text)('device_id').primaryKey(),
    mac: (0, sqlite_core_1.text)('mac').notNull(),
    name: (0, sqlite_core_1.text)('name'),
    role: (0, sqlite_core_1.text)('role').notNull(),
    link_key_encrypted: (0, sqlite_core_1.text)('link_key_encrypted'),
    auto_reconnect: (0, sqlite_core_1.integer)('auto_reconnect').notNull().default(1),
    paired_at: (0, sqlite_core_1.integer)('paired_at').notNull(),
    last_connected_at: (0, sqlite_core_1.integer)('last_connected_at'),
});
//# sourceMappingURL=schema.js.map