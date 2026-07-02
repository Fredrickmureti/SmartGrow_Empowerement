import { useState, useCallback, useEffect } from 'react';
import { Shield, Loader2, AlertTriangle, CheckCircle2, Delete, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import type { OverrideAction } from '@/hooks/pos/useManagerOverride';

const ACTION_LABELS: Record<OverrideAction, { title: string; description: string; icon: string }> = {
  void_transaction: {
    title: 'Void Transaction',
    description: 'Requires manager approval to void this transaction',
    icon: '🚫',
  },
  price_change: {
    title: 'Price Override',
    description: 'Manager approval needed to change item price',
    icon: '💰',
  },
  discount_over_limit: {
    title: 'Discount Override',
    description: 'Discount exceeds cashier limit, manager approval required',
    icon: '🏷️',
  },
  refund: {
    title: 'Process Refund',
    description: 'Manager approval required for refund',
    icon: '↩️',
  },
  no_sale: {
    title: 'No Sale',
    description: 'Opening cash drawer without sale requires approval',
    icon: '🔓',
  },
  cash_drop: {
    title: 'Cash Drop',
    description: 'Manager verification for cash drop',
    icon: '💵',
  },
  override_age_check: {
    title: 'Age Verification Override',
    description: 'Override age-restricted item check',
    icon: '🔞',
  },
  delete_item: {
    title: 'Delete Item',
    description: 'Remove item from transaction',
    icon: '🗑️',
  },
  manual_price: {
    title: 'Manual Price Entry',
    description: 'Enter custom price for item',
    icon: '✏️',
  },
  cross_tender_refund: {
    title: 'Cross-Tender Refund',
    description: 'Refund tender differs from the original sale; manager approval required',
    icon: '🔁',
  },
  void_above_threshold: {
    title: 'Void Over Threshold',
    description: 'Voiding this transaction exceeds the configured limit; manager approval required',
    icon: '🛑',
  },
  cash_out_above_threshold: {
    title: 'Cash Out Over Threshold',
    description: 'Cash-out exceeds the configured limit; manager approval required',
    icon: '💸',
  },
  safe_drop: {
    title: 'Safe Drop',
    description: 'Safe-drop amount requires manager approval',
    icon: '🏦',
  },
  bank_deposit: {
    title: 'Bank Deposit',
    description: 'Bank deposit amount requires manager approval',
    icon: '🏛️',
  },
  shift_variance: {
    title: 'Shift Variance',
    description: 'Cash variance exceeds tolerance; manager approval required to close',
    icon: '⚖️',
  },
  reopen_shift: {
    title: 'Reopen Shift',
    description: 'Admin: reverse the close GL entry and reopen this shift',
    icon: '🔓',
  },
  force_close_shift: {
    title: 'Force-Close Shift',
    description: 'Rescue an orphaned shift; manager approval required',
    icon: '🚨',
  },
};

interface ManagerOverrideDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: OverrideAction;
  originalValue?: number | string;
  newValue?: number | string;
  onApprove: (pin: string, reason?: string) => Promise<void>;
  isVerifying?: boolean;
}

export function ManagerOverrideDialog({
  open,
  onOpenChange,
  action,
  originalValue,
  newValue,
  onApprove,
  isVerifying = false,
}: ManagerOverrideDialogProps) {
  const [pin, setPin] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const actionInfo = ACTION_LABELS[action];

  // Reset state when dialog opens/closes
  useEffect(() => {
    if (open) {
      setPin('');
      setReason('');
      setError(null);
      setSuccess(false);
    }
  }, [open]);

  const handleKeyPress = useCallback((key: string) => {
    if (key === 'clear') {
      setPin('');
    } else if (key === 'backspace') {
      setPin(prev => prev.slice(0, -1));
    } else if (pin.length < 6) {
      setPin(prev => prev + key);
    }
    setError(null);
  }, [pin]);

  const handleSubmit = useCallback(async () => {
    if (pin.length < 4) {
      setError('PIN must be at least 4 digits');
      return;
    }

    try {
      await onApprove(pin, reason || undefined);
      setSuccess(true);
      setTimeout(() => {
        onOpenChange(false);
      }, 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid PIN');
      setPin('');
    }
  }, [pin, reason, onApprove, onOpenChange]);

  // Keyboard support
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && pin.length >= 4 && !isVerifying) {
        handleSubmit();
      } else if (e.key === 'Backspace') {
        setPin(prev => prev.slice(0, -1));
      } else if (e.key === 'Escape') {
        onOpenChange(false);
      } else if (/^\d$/.test(e.key) && pin.length < 6) {
        setPin(prev => prev + e.key);
        setError(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, pin, isVerifying, handleSubmit, onOpenChange]);

  const keypadButtons = [
    ['7', '8', '9'],
    ['4', '5', '6'],
    ['1', '2', '3'],
    ['C', '0', '⌫'],
  ];

  if (success) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-[400px]">
          <div className="flex flex-col items-center justify-center py-8">
            <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mb-4">
              <CheckCircle2 className="h-8 w-8 text-green-600 dark:text-green-400" />
            </div>
            <h3 className="text-xl font-semibold text-green-600 dark:text-green-400">
              Approved
            </h3>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader className="text-center">
          <div className="mx-auto w-14 h-14 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center mb-2">
            <Shield className="h-7 w-7 text-amber-600 dark:text-amber-400" />
          </div>
          <DialogTitle className="text-xl">
            <span className="mr-2">{actionInfo.icon}</span>
            {actionInfo.title}
          </DialogTitle>
          <DialogDescription>
            {actionInfo.description}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 mt-4">
          {/* Value Change Display */}
          {(originalValue || newValue) && (
            <div className="p-3 rounded-lg bg-muted text-sm">
              {originalValue && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Original:</span>
                  <span className="font-medium">{originalValue}</span>
                </div>
              )}
              {newValue && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">New:</span>
                  <span className="font-medium text-primary">{newValue}</span>
                </div>
              )}
            </div>
          )}

          {/* Error Display */}
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 text-destructive text-sm">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* PIN Entry */}
          <div className="space-y-2">
            <Label className="text-center block">Manager PIN</Label>
            <div className="flex justify-center gap-2">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div
                  key={i}
                  className={`w-8 h-10 rounded-md border-2 flex items-center justify-center transition-all ${
                    i < pin.length
                      ? 'bg-primary border-primary'
                      : 'bg-muted border-border'
                  }`}
                >
                  {i < pin.length && (
                    <div className="w-2.5 h-2.5 rounded-full bg-primary-foreground" />
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Compact Numeric Keypad */}
          <div className="grid grid-cols-3 gap-1.5">
            {keypadButtons.flat().map((key) => (
              <Button
                key={key}
                variant="outline"
                size="sm"
                className="h-10 text-lg font-medium"
                disabled={isVerifying}
                onClick={() => {
                  if (key === 'C') {
                    setPin('');
                  } else if (key === '⌫') {
                    setPin(prev => prev.slice(0, -1));
                  } else {
                    handleKeyPress(key);
                  }
                }}
              >
                {key === '⌫' ? <Delete className="h-4 w-4" /> : key === 'C' ? <X className="h-4 w-4" /> : key}
              </Button>
            ))}
          </div>

          {/* Reason (optional) */}
          <div className="space-y-2">
            <Label htmlFor="reason">Reason (optional)</Label>
            <Textarea
              id="reason"
              placeholder="Enter reason for override..."
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="h-16 resize-none"
            />
          </div>

          {/* Actions */}
          <div className="flex gap-2">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => onOpenChange(false)}
              disabled={isVerifying}
            >
              Cancel
            </Button>
            <Button
              className="flex-1"
              onClick={handleSubmit}
              disabled={isVerifying || pin.length < 4}
            >
              {isVerifying ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Verifying...
                </>
              ) : (
                'Approve'
              )}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
