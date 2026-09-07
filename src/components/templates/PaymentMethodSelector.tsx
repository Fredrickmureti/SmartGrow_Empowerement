import { usePaymentMethods } from "@/hooks/usePaymentMethods";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { 
  Building2, 
  Smartphone, 
  CreditCard, 
  Banknote, 
  QrCode,
  Settings2,
  ExternalLink
} from "lucide-react";
import { Link } from "react-router-dom";
import { 
  OrganizationPaymentMethod, 
  PaymentMethodType,
  PAYMENT_METHOD_TYPES 
} from "@/types/paymentMethod";

interface PaymentMethodSelectorProps {
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  disabled?: boolean;
}

const typeIcons: Record<PaymentMethodType, React.ReactNode> = {
  bank: <Building2 className="h-4 w-4" />,
  mobile_money: <Smartphone className="h-4 w-4" />,
  cash: <Banknote className="h-4 w-4" />,
};

export function PaymentMethodSelector({
  selectedIds,
  onSelectionChange,
  disabled = false,
}: PaymentMethodSelectorProps) {
  const { activePaymentMethods, isLoading } = usePaymentMethods();

  const handleToggle = (id: string, checked: boolean) => {
    if (checked) {
      onSelectionChange([...selectedIds, id]);
    } else {
      onSelectionChange(selectedIds.filter((i) => i !== id));
    }
  };

  const handleSelectAll = () => {
    if (selectedIds.length === activePaymentMethods.length) {
      onSelectionChange([]);
    } else {
      onSelectionChange(activePaymentMethods.map((m) => m.id));
    }
  };

  const getMethodSubtitle = (method: OrganizationPaymentMethod): string => {
    const details = method.details;
    
    switch (method.type) {
      case 'bank':
        return (details as any).bank_name || '';
      case 'mobile_money':
        return (details as any).paybill_number
          ? `PayBill: ${(details as any).paybill_number}`
          : '';
      case 'cash':
        return 'Cash payment';
      default:
        return '';
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (activePaymentMethods.length === 0) {
    return (
      <div className="rounded-lg border border-dashed p-6 text-center">
        <CreditCard className="h-8 w-8 mx-auto mb-3 text-muted-foreground" />
        <p className="text-sm font-medium mb-1">No payment methods configured</p>
        <p className="text-xs text-muted-foreground mb-4">
          Add payment methods to display on your documents
        </p>
        <Button asChild size="sm" variant="outline">
          <Link to="/settings" className="gap-2">
            <Settings2 className="h-4 w-4" />
            Go to Settings
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Select which payment methods appear on this document type
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleSelectAll}
          disabled={disabled}
        >
          {selectedIds.length === activePaymentMethods.length ? "Deselect All" : "Select All"}
        </Button>
      </div>

      <div className="space-y-2">
        {activePaymentMethods.map((method) => (
          <div
            key={method.id}
            className={`flex items-center gap-3 rounded-lg border p-3 transition-colors ${
              selectedIds.includes(method.id)
                ? "border-primary bg-primary/5"
                : "border-border hover:bg-muted/50"
            } ${disabled ? "opacity-50 pointer-events-none" : "cursor-pointer"}`}
            onClick={() => !disabled && handleToggle(method.id, !selectedIds.includes(method.id))}
          >
            <Checkbox
              id={method.id}
              checked={selectedIds.includes(method.id)}
              onCheckedChange={(checked) => handleToggle(method.id, !!checked)}
              disabled={disabled}
            />
            <div className="h-8 w-8 rounded-md bg-muted flex items-center justify-center flex-shrink-0">
              {typeIcons[method.type]}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <Label
                  htmlFor={method.id}
                  className="font-medium cursor-pointer"
                >
                  {method.label}
                </Label>
                {method.is_default && (
                  <Badge variant="secondary" className="text-xs">
                    Default
                  </Badge>
                )}
                {method.qr_code_enabled && (
                  <QrCode className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </div>
              <p className="text-xs text-muted-foreground truncate">
                {PAYMENT_METHOD_TYPES[method.type].label}
                {getMethodSubtitle(method) && ` • ${getMethodSubtitle(method)}`}
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between pt-2 border-t">
        <p className="text-xs text-muted-foreground">
          {selectedIds.length} of {activePaymentMethods.length} selected
        </p>
        <Button asChild variant="link" size="sm" className="h-auto p-0 text-xs">
          <Link to="/settings" className="gap-1">
            Manage Payment Methods
            <ExternalLink className="h-3 w-3" />
          </Link>
        </Button>
      </div>
    </div>
  );
}
