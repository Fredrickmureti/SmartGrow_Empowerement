"use strict";
/**
 * Transaction-Specific Sync Handler
 * Handles ACID-compliant POS transaction sync with items and payments
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.transactionSync = void 0;
const DatabaseManager_1 = require("./DatabaseManager");
const AuditLogger_1 = require("./AuditLogger");
const uuid_1 = require("uuid");
class TransactionSyncHandler {
    constructor() {
        this.supabaseUrl = null;
        this.supabaseKey = null;
        this.accessToken = null;
        this.organizationId = null;
    }
    /**
     * Configure the sync handler
     */
    configure(config) {
        this.supabaseUrl = config.supabaseUrl;
        this.supabaseKey = config.supabaseKey;
        this.accessToken = config.accessToken || null;
        this.organizationId = config.organizationId;
    }
    /**
     * Save a transaction locally with ACID guarantees
     */
    saveTransactionLocally(data) {
        const db = DatabaseManager_1.databaseManager.getDatabase();
        try {
            const transaction = db.transaction(() => {
                // Insert transaction
                const txStmt = db.prepare(`
          INSERT INTO pos_transactions (
            id, organization_id, transaction_number, register_id, shift_id, customer_id,
            subtotal, tax_amount, discount_amount, discount_type, total,
            payment_status, status, notes, created_by,
            etims_cu_number, etims_qr_code_url,
            sync_status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))
        `);
                txStmt.run(data.transaction.id, this.organizationId, data.transaction.transaction_number, data.transaction.register_id, data.transaction.shift_id, data.transaction.customer_id, data.transaction.subtotal, data.transaction.tax_amount, data.transaction.discount_amount, data.transaction.discount_type, data.transaction.total, data.transaction.payment_status, data.transaction.status, data.transaction.notes, data.transaction.created_by, data.transaction.etims_cu_number, data.transaction.etims_qr_code_url);
                // Insert items
                const itemStmt = db.prepare(`
          INSERT INTO pos_transaction_items (
            id, transaction_id, product_id, description, quantity, unit_price,
            discount_type, discount_value, tax_rate, tax_amount, line_total,
            cost_price, sort_order, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `);
                for (const item of data.items) {
                    itemStmt.run(item.id, data.transaction.id, item.product_id, item.description, item.quantity, item.unit_price, item.discount_type, item.discount_value, item.tax_rate, item.tax_amount, item.line_total, item.cost_price, item.sort_order);
                    // Update local stock if product tracked
                    if (item.product_id) {
                        db.prepare(`
              UPDATE products 
              SET stock_quantity = stock_quantity - ?
              WHERE id = ? AND track_inventory = 1
            `).run(item.quantity, item.product_id);
                        // Record stock movement
                        db.prepare(`
              INSERT INTO stock_movements (
                id, organization_id, product_id, movement_type, quantity,
                reference_type, reference_id, performed_by, sync_status, created_at
              ) VALUES (?, ?, ?, 'sale', ?, 'pos_transaction', ?, ?, 'pending', datetime('now'))
            `).run((0, uuid_1.v4)(), this.organizationId, item.product_id, -item.quantity, data.transaction.id, data.transaction.created_by);
                    }
                }
                // Insert payments
                const paymentStmt = db.prepare(`
          INSERT INTO pos_transaction_payments (
            id, transaction_id, payment_method, amount, reference,
            mpesa_receipt, change_given, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', datetime('now'))
        `);
                for (const payment of data.payments) {
                    paymentStmt.run(payment.id, data.transaction.id, payment.payment_method, payment.amount, payment.reference, payment.mpesa_receipt, payment.change_given);
                }
                // Update shift totals if applicable
                if (data.transaction.shift_id) {
                    const cashAmount = data.payments
                        .filter(p => p.payment_method === 'cash')
                        .reduce((sum, p) => sum + p.amount, 0);
                    const cardAmount = data.payments
                        .filter(p => p.payment_method === 'card')
                        .reduce((sum, p) => sum + p.amount, 0);
                    const mpesaAmount = data.payments
                        .filter(p => p.payment_method === 'mpesa')
                        .reduce((sum, p) => sum + p.amount, 0);
                    db.prepare(`
            UPDATE pos_shifts SET
              cash_sales = cash_sales + ?,
              card_sales = card_sales + ?,
              mpesa_sales = mpesa_sales + ?,
              total_sales = total_sales + ?,
              transaction_count = transaction_count + 1,
              expected_cash = expected_cash + ?,
              updated_at = datetime('now'),
              local_version = local_version + 1
            WHERE id = ?
          `).run(cashAmount, cardAmount, mpesaAmount, data.transaction.total, cashAmount - data.payments.reduce((sum, p) => sum + (p.change_given || 0), 0), data.transaction.shift_id);
                }
            });
            transaction();
            // Log the transaction
            AuditLogger_1.auditLogger.logTransaction(data.transaction.id, data);
            return {
                success: true,
                transactionId: data.transaction.id,
            };
        }
        catch (error) {
            console.error('Failed to save transaction locally:', error);
            return {
                success: false,
                transactionId: data.transaction.id,
                error: error instanceof Error ? error.message : 'Failed to save transaction',
            };
        }
    }
    /**
     * Sync a single transaction to the server
     */
    async syncTransactionToServer(transactionId) {
        const db = DatabaseManager_1.databaseManager.getDatabase();
        try {
            // Get transaction with items and payments
            const transaction = db.prepare('SELECT * FROM pos_transactions WHERE id = ?').get(transactionId);
            if (!transaction) {
                return { success: false, transactionId, error: 'Transaction not found' };
            }
            const items = db.prepare('SELECT * FROM pos_transaction_items WHERE transaction_id = ?').all(transactionId);
            const payments = db.prepare('SELECT * FROM pos_transaction_payments WHERE transaction_id = ?').all(transactionId);
            // Mark as syncing
            db.prepare('UPDATE pos_transactions SET sync_status = ? WHERE id = ?').run('syncing', transactionId);
            // Call Supabase RPC to process transaction atomically
            const response = await this.callSupabaseRPC('process_pos_transaction', {
                p_transaction: {
                    organization_id: this.organizationId,
                    transaction_number: transaction.transaction_number,
                    register_id: transaction.register_id,
                    shift_id: transaction.shift_id,
                    customer_id: transaction.customer_id,
                    subtotal: transaction.subtotal,
                    tax_amount: transaction.tax_amount,
                    discount_amount: transaction.discount_amount,
                    discount_type: transaction.discount_type,
                    total: transaction.total,
                    payment_status: transaction.payment_status,
                    status: transaction.status,
                    notes: transaction.notes,
                    created_by: transaction.created_by,
                },
                p_items: items.map(item => ({
                    product_id: item.product_id,
                    description: item.description,
                    quantity: item.quantity,
                    unit_price: item.unit_price,
                    discount_type: item.discount_type,
                    discount_value: item.discount_value,
                    tax_rate: item.tax_rate,
                    tax_amount: item.tax_amount,
                    line_total: item.line_total,
                    cost_price: item.cost_price,
                    sort_order: item.sort_order,
                })),
                p_payments: payments.map(payment => ({
                    payment_method: payment.payment_method,
                    amount: payment.amount,
                    reference: payment.reference,
                    mpesa_receipt: payment.mpesa_receipt,
                    change_given: payment.change_given,
                })),
            });
            if (response.success) {
                // Update local record with server ID
                db.prepare(`
          UPDATE pos_transactions 
          SET sync_status = 'synced', 
              server_id = ?,
              synced_at = datetime('now'),
              sync_error = NULL
          WHERE id = ?
        `).run(response.data?.transaction_id, transactionId);
                return {
                    success: true,
                    transactionId,
                    serverId: response.data?.transaction_id,
                };
            }
            else {
                throw new Error(response.error || 'Server sync failed');
            }
        }
        catch (error) {
            const errorMsg = error instanceof Error ? error.message : 'Unknown error';
            // Mark as failed
            db.prepare(`
        UPDATE pos_transactions 
        SET sync_status = 'failed', sync_error = ?
        WHERE id = ?
      `).run(errorMsg, transactionId);
            return {
                success: false,
                transactionId,
                error: errorMsg,
            };
        }
    }
    /**
     * Sync all pending transactions
     */
    async syncAllPendingTransactions() {
        const db = DatabaseManager_1.databaseManager.getDatabase();
        const pending = db.prepare(`
      SELECT id FROM pos_transactions 
      WHERE sync_status IN ('pending', 'failed')
      ORDER BY created_at ASC
      LIMIT 50
    `).all();
        const result = {
            total: pending.length,
            synced: 0,
            failed: 0,
            errors: [],
        };
        for (const { id } of pending) {
            const syncResult = await this.syncTransactionToServer(id);
            if (syncResult.success) {
                result.synced++;
            }
            else {
                result.failed++;
                result.errors.push({ id, error: syncResult.error || 'Unknown error' });
            }
        }
        return result;
    }
    /**
     * Call a Supabase RPC function
     */
    async callSupabaseRPC(functionName, params) {
        if (!this.supabaseUrl || !this.supabaseKey) {
            return { success: false, error: 'Supabase not configured' };
        }
        try {
            const headers = {
                'apikey': this.supabaseKey,
                'Content-Type': 'application/json',
            };
            if (this.accessToken) {
                headers['Authorization'] = `Bearer ${this.accessToken}`;
            }
            const response = await fetch(`${this.supabaseUrl}/rest/v1/rpc/${functionName}`, {
                method: 'POST',
                headers,
                body: JSON.stringify(params),
            });
            if (response.ok) {
                const data = await response.json();
                return { success: true, data };
            }
            else {
                const error = await response.text();
                return { success: false, error };
            }
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : 'RPC call failed',
            };
        }
    }
    /**
     * Void a transaction locally
     */
    voidTransaction(transactionId, reason, voidedBy) {
        const db = DatabaseManager_1.databaseManager.getDatabase();
        try {
            const transaction = db.transaction(() => {
                // Get original transaction
                const original = db.prepare('SELECT * FROM pos_transactions WHERE id = ?').get(transactionId);
                if (!original) {
                    throw new Error('Transaction not found');
                }
                if (original.status === 'voided') {
                    throw new Error('Transaction already voided');
                }
                // Update transaction status
                db.prepare(`
          UPDATE pos_transactions 
          SET status = 'voided',
              notes = COALESCE(notes, '') || ' | VOIDED: ' || ?,
              updated_at = datetime('now'),
              sync_status = 'pending',
              local_version = local_version + 1
          WHERE id = ?
        `).run(reason, transactionId);
                // Restore stock for each item
                const items = db.prepare('SELECT * FROM pos_transaction_items WHERE transaction_id = ?').all(transactionId);
                for (const item of items) {
                    if (item.product_id) {
                        db.prepare(`
              UPDATE products 
              SET stock_quantity = stock_quantity + ?
              WHERE id = ? AND track_inventory = 1
            `).run(item.quantity, item.product_id);
                        // Record stock movement reversal
                        db.prepare(`
              INSERT INTO stock_movements (
                id, organization_id, product_id, movement_type, quantity,
                reference_type, reference_id, notes, performed_by, sync_status, created_at
              ) VALUES (?, ?, ?, 'void_reversal', ?, 'pos_transaction', ?, ?, ?, 'pending', datetime('now'))
            `).run((0, uuid_1.v4)(), this.organizationId, item.product_id, item.quantity, // Positive to add back
                        transactionId, `Void: ${reason}`, voidedBy);
                    }
                }
                // Update shift totals if applicable
                if (original.shift_id) {
                    const payments = db.prepare('SELECT * FROM pos_transaction_payments WHERE transaction_id = ?').all(transactionId);
                    const cashAmount = payments.filter(p => p.payment_method === 'cash').reduce((sum, p) => sum + p.amount, 0);
                    const cardAmount = payments.filter(p => p.payment_method === 'card').reduce((sum, p) => sum + p.amount, 0);
                    const mpesaAmount = payments.filter(p => p.payment_method === 'mpesa').reduce((sum, p) => sum + p.amount, 0);
                    db.prepare(`
            UPDATE pos_shifts SET
              cash_sales = cash_sales - ?,
              card_sales = card_sales - ?,
              mpesa_sales = mpesa_sales - ?,
              total_sales = total_sales - ?,
              transaction_count = transaction_count - 1,
              updated_at = datetime('now'),
              local_version = local_version + 1
            WHERE id = ?
          `).run(cashAmount, cardAmount, mpesaAmount, original.total, original.shift_id);
                }
            });
            transaction();
            // Log the void
            AuditLogger_1.auditLogger.logVoid(transactionId, reason);
            return true;
        }
        catch (error) {
            console.error('Failed to void transaction:', error);
            return false;
        }
    }
}
// Singleton instance
exports.transactionSync = new TransactionSyncHandler();
//# sourceMappingURL=TransactionSync.js.map