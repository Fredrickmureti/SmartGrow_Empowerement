/**
 * Print Fallback Dialog
 * Shows when no printer is available (like Square, Toast, Clover behavior)
 * Offers digital alternatives: Save PDF, Email Receipt, View Preview
 */

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  FileDown,
  Mail,
  Eye,
  RefreshCw,
  Printer,
  AlertTriangle,
  CheckCircle2,
  Loader2,
} from "lucide-react";
import type { PrinterStatus, PrintFallbackAction } from "@/services/printing/types";

interface PrintFallbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  printerStatus: PrinterStatus | null;
  onAction: (action: PrintFallbackAction) => void;
  isProcessing?: boolean;
  transactionNumber?: string;
  showEmailOption?: boolean;
}

export function PrintFallbackDialog({
  open,
  onOpenChange,
  printerStatus,
  onAction,
  isProcessing = false,
  transactionNumber,
  showEmailOption = true,
}: PrintFallbackDialogProps) {
  const [selectedAction, setSelectedAction] = useState<PrintFallbackAction | null>(null);

  const handleAction = (action: PrintFallbackAction) => {
    setSelectedAction(action);
    onAction(action);
    if (action === 'cancel') {
      onOpenChange(false);
    }
  };

  const handleRetry = () => {
    setSelectedAction('retry');
    onAction('retry');
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            No Printer Detected
          </DialogTitle>
          <DialogDescription>
            {transactionNumber && (
              <span className="block text-sm font-medium text-foreground mb-1">
                Transaction: {transactionNumber}
              </span>
            )}
            We couldn't find a connected printer. Choose an alternative to save your receipt:
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-4">
          {/* Printer Status Info */}
          <Alert variant="default" className="bg-muted/50">
            <Printer className="h-4 w-4" />
            <AlertTitle className="text-sm">Printer Status</AlertTitle>
            <AlertDescription className="text-xs">
              {printerStatus?.printerCount === 0 
                ? "No printers found on this system"
                : `${printerStatus?.printerCount || 0} printer(s) - none available`
              }
              {printerStatus?.lastChecked && (
                <span className="block text-muted-foreground mt-1">
                  Last checked: {printerStatus.lastChecked.toLocaleTimeString()}
                </span>
              )}
            </AlertDescription>
          </Alert>

          {/* Action Options */}
          <div className="grid gap-2">
            {/* Save as PDF - Primary option */}
            <Button
              variant="default"
              className="w-full justify-start h-auto py-3"
              onClick={() => handleAction('pdf')}
              disabled={isProcessing}
            >
              {selectedAction === 'pdf' && isProcessing ? (
                <Loader2 className="h-5 w-5 mr-3 animate-spin" />
              ) : (
                <FileDown className="h-5 w-5 mr-3" />
              )}
              <div className="text-left">
                <div className="font-medium">Save as PDF</div>
                <div className="text-xs opacity-80">Download receipt to your computer</div>
              </div>
            </Button>

            {/* Email Receipt */}
            {showEmailOption && (
              <Button
                variant="outline"
                className="w-full justify-start h-auto py-3"
                onClick={() => handleAction('email')}
                disabled={isProcessing}
              >
                {selectedAction === 'email' && isProcessing ? (
                  <Loader2 className="h-5 w-5 mr-3 animate-spin" />
                ) : (
                  <Mail className="h-5 w-5 mr-3" />
                )}
                <div className="text-left">
                  <div className="font-medium">Email Receipt</div>
                  <div className="text-xs text-muted-foreground">Send digital receipt to customer</div>
                </div>
              </Button>
            )}

            {/* View Preview */}
            <Button
              variant="outline"
              className="w-full justify-start h-auto py-3"
              onClick={() => handleAction('preview')}
              disabled={isProcessing}
            >
              <Eye className="h-5 w-5 mr-3" />
              <div className="text-left">
                <div className="font-medium">View Receipt</div>
                <div className="text-xs text-muted-foreground">Preview on screen without printing</div>
              </div>
            </Button>
          </div>
        </div>

        <DialogFooter className="flex-col sm:flex-row gap-2">
          <Button
            variant="ghost"
            onClick={handleRetry}
            disabled={isProcessing}
            className="gap-2"
          >
            <RefreshCw className={`h-4 w-4 ${selectedAction === 'retry' && isProcessing ? 'animate-spin' : ''}`} />
            Check Again
          </Button>
          <Button
            variant="ghost"
            onClick={() => handleAction('cancel')}
            disabled={isProcessing}
          >
            Skip Receipt
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Compact printer status indicator for POS terminal header
 */
interface PrinterStatusIndicatorProps {
  status: PrinterStatus | null;
  onClick?: () => void;
}

export function PrinterStatusIndicator({ status, onClick }: PrinterStatusIndicatorProps) {
  if (!status) return null;

  const isAvailable = status.available;

  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors ${
        isAvailable
          ? 'bg-green-500/10 text-green-600 hover:bg-green-500/20'
          : 'bg-amber-500/10 text-amber-600 hover:bg-amber-500/20'
      }`}
      title={isAvailable 
        ? `Printer: ${status.defaultPrinter || 'Available'}`
        : 'No printer connected'
      }
    >
      {isAvailable ? (
        <CheckCircle2 className="h-3.5 w-3.5" />
      ) : (
        <AlertTriangle className="h-3.5 w-3.5" />
      )}
      <span className="hidden sm:inline">
        {isAvailable ? 'Printer Ready' : 'No Printer'}
      </span>
      <Printer className="h-3.5 w-3.5 sm:hidden" />
    </button>
  );
}
