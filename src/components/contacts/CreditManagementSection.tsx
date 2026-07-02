import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { usePaymentTerms } from "@/hooks/usePaymentTerms";
import { useCustomerGroups } from "@/hooks/useCustomerGroups";
import { AlertTriangle, CreditCard, Settings } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { CustomerGroupsDialog } from "./CustomerGroupsDialog";

// Fallback groups for when database groups aren't available
const FALLBACK_CUSTOMER_GROUPS = [
  { value: "retail", label: "Retail" },
  { value: "wholesale", label: "Wholesale" },
  { value: "distributor", label: "Distributor" },
  { value: "vip", label: "VIP" },
  { value: "government", label: "Government" },
];

interface CreditManagementSectionProps {
  creditLimit: string;
  creditHold: boolean;
  paymentTermId: string;
  customerGroupId: string;
  onCreditLimitChange: (value: string) => void;
  onCreditHoldChange: (value: boolean) => void;
  onPaymentTermIdChange: (value: string) => void;
  onCustomerGroupIdChange: (value: string) => void;
  showForType: "customer" | "supplier" | "both";
  onGroupsDialogChange?: (open: boolean) => void;
}

export function CreditManagementSection({
  creditLimit,
  creditHold,
  paymentTermId,
  customerGroupId,
  onCreditLimitChange,
  onCreditHoldChange,
  onPaymentTermIdChange,
  onCustomerGroupIdChange,
  showForType,
  onGroupsDialogChange,
}: CreditManagementSectionProps) {
  const { paymentTerms, isLoading: loadingTerms } = usePaymentTerms();
  const { activeGroups, isLoading: loadingGroups } = useCustomerGroups();
  const [showGroupsDialog, setShowGroupsDialog] = useState(false);

  const handleGroupsDialogChange = (open: boolean) => {
    setShowGroupsDialog(open);
    onGroupsDialogChange?.(open);
  };

  // Only show for customers
  if (showForType === "supplier") {
    return null;
  }

  // Use database groups if available, otherwise use fallback
  const groupOptions = activeGroups.length > 0
    ? activeGroups.map((g) => ({ value: g.id, label: g.name }))
    : FALLBACK_CUSTOMER_GROUPS;

  return (
    <div className="space-y-4 border-t pt-4">
      <div className="flex items-center gap-2">
        <CreditCard className="h-4 w-4 text-muted-foreground" />
        <h4 className="font-medium">Credit & Pricing Settings</h4>
        {creditHold && (
          <Badge variant="destructive" className="ml-auto">
            <AlertTriangle className="h-3 w-3 mr-1" />
            Credit Hold
          </Badge>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="credit_limit">Credit Limit</Label>
          <Input
            id="credit_limit"
            type="number"
            min="0"
            step="0.01"
            placeholder="No limit"
            value={creditLimit}
            onChange={(e) => onCreditLimitChange(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Leave empty for no credit limit
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="payment_term">Default Payment Terms</Label>
          <Select
            value={paymentTermId}
            onValueChange={onPaymentTermIdChange}
            disabled={loadingTerms}
          >
            <SelectTrigger id="payment_term">
              <SelectValue placeholder="Select payment terms" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No default</SelectItem>
              {paymentTerms.map((term) => (
                <SelectItem key={term.id} value={term.id}>
                  {term.name} ({term.days} days)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="customer_group">Customer Group</Label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => handleGroupsDialogChange(true)}
            >
              <Settings className="h-3 w-3 mr-1" />
              Manage
            </Button>
          </div>
          <Select
            value={customerGroupId}
            onValueChange={onCustomerGroupIdChange}
            disabled={loadingGroups}
          >
            <SelectTrigger id="customer_group">
              <SelectValue placeholder="Select group" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No group</SelectItem>
              {groupOptions.map((group) => (
                <SelectItem key={group.value} value={group.value}>
                  {group.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between rounded-lg border p-3">
          <div className="space-y-0.5">
            <Label htmlFor="credit_hold" className="cursor-pointer">
              Credit Hold
            </Label>
            <p className="text-xs text-muted-foreground">
              Block new orders for this customer
            </p>
          </div>
          <Switch
            id="credit_hold"
            checked={creditHold}
            onCheckedChange={onCreditHoldChange}
          />
        </div>
      </div>

      {/* Customer Groups Management Dialog */}
      <CustomerGroupsDialog
        open={showGroupsDialog}
        onOpenChange={handleGroupsDialogChange}
      />
    </div>
  );
}
