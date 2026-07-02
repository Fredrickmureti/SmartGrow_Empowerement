/**
 * Payment Terminal Driver — Extensible framework for payment device integration.
 * 
 * This is a STUB implementation providing the contract and lifecycle.
 * Real integrations (Worldline, Adyen, etc.) will extend this pattern
 * with actual protocol implementations when hardware is available.
 */

import type {
  IDriver, DriverType, DeviceRole, ConnectionBackend,
  DeviceStatus, DriverCommand, DriverResult, PaymentCommand, DeviceInfo,
} from './DriverInterface';

export type PaymentProvider = 'worldline' | 'adyen' | 'generic';

export interface PaymentResult {
  approved: boolean;
  transactionId?: string;
  authCode?: string;
  cardType?: string;
  lastFourDigits?: string;
  amount: number;
  currency: string;
  errorMessage?: string;
}

export type PaymentStatusCallback = (result: PaymentResult) => void;

export class PaymentTerminalDriver implements IDriver {
  readonly driverType: DriverType;
  readonly supportedRoles: DeviceRole[] = ['payment_terminal'];
  readonly supportedBackends: ConnectionBackend[] = ['network', 'electron'];

  supported(deviceInfo: DeviceInfo): number {
    if (deviceInfo.connectionType === 'network') return 3;
    return 0;
  }

  private provider: PaymentProvider;
  private _status: DeviceStatus = { connected: false, status: 'unknown' };
  private onResultCallbacks: Set<PaymentStatusCallback> = new Set();

  constructor(provider: PaymentProvider = 'generic') {
    this.provider = provider;
    this.driverType = `${provider}_terminal` as DriverType;
  }

  async connect(params: Record<string, unknown>): Promise<DriverResult> {
    console.log(`[PaymentTerminalDriver/${this.provider}] Connect requested`, params);
    
    const ipAddress = params.ipAddress as string;
    const port = params.port as number;

    if (!ipAddress || !port) {
      this._status = { connected: false, status: 'error', lastError: 'IP and port required' };
      return { success: false, error: 'Payment terminal requires IP address and port' };
    }

    // STUB: Real terminal protocols (Worldline ZVT, Adyen Cloud API) not yet implemented.
    // Mark as configuring, NOT connected — so users see the truth.
    this._status = {
      connected: false,
      status: 'configuring',
      lastSeenAt: new Date().toISOString(),
      lastError: `${this.provider} terminal integration is pending. Device registered but not yet functional.`,
      capabilities: ['card_payment', 'contactless', 'refund'],
    };

    return { 
      success: true, 
      data: { 
        warning: `${this.provider} terminal driver is a stub. Configuration saved but terminal communication is not yet implemented.` 
      } 
    };
  }

  async disconnect(): Promise<DriverResult> {
    this._status = { connected: false, status: 'offline' };
    this.onResultCallbacks.clear();
    return { success: true };
  }

  getStatus(): DeviceStatus {
    return this._status;
  }

  async execute(command: DriverCommand): Promise<DriverResult> {
    if (command.type === 'initiate_payment') {
      const paymentCmd = command as PaymentCommand;
      return this.initiatePayment(
        paymentCmd.payload.amount,
        paymentCmd.payload.currency,
        paymentCmd.payload.reference
      );
    }

    if (command.type === 'cancel_payment') {
      return this.cancelPayment();
    }

    if (command.type === 'get_terminal_status') {
      return { success: true, data: { provider: this.provider, status: this._status } };
    }

    return { success: false, error: `Unknown command: ${command.type}` };
  }

  async testConnection(): Promise<boolean> {
    // In production, would send a status inquiry to the terminal
    return this._status.connected;
  }

  /**
   * Subscribe to payment results
   */
  onPaymentResult(callback: PaymentStatusCallback): () => void {
    this.onResultCallbacks.add(callback);
    return () => this.onResultCallbacks.delete(callback);
  }

  private async initiatePayment(
    amount: number,
    currency: string,
    reference: string
  ): Promise<DriverResult> {
    if (!this._status.connected) {
      return { success: false, error: 'Terminal not connected' };
    }

    console.log(`[PaymentTerminalDriver/${this.provider}] Payment: ${currency} ${amount} ref=${reference}`);

    // STUB: In production, this sends the payment request to the terminal
    // and waits for the result via callback/polling.
    // For now, return a pending state.
    return {
      success: true,
      data: {
        status: 'pending',
        message: `Payment of ${currency} ${amount} sent to ${this.provider} terminal. Awaiting customer action.`,
        provider: this.provider,
        reference,
      },
    };
  }

  private async cancelPayment(): Promise<DriverResult> {
    if (!this._status.connected) {
      return { success: false, error: 'Terminal not connected' };
    }

    console.log(`[PaymentTerminalDriver/${this.provider}] Payment cancelled`);
    return { success: true };
  }
}
