import { useState, useEffect, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ConfirmDeleteDialog } from "@/components/shared/ConfirmDeleteDialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { ReactNode } from "react";

/**
 * Lazy-mount wrapper around Radix TabsContent.
 *
 * Radix TabsContent renders its children for EVERY value (just hides
 * inactive ones with `hidden=""`) for accessibility. In POS Settings that
 * means all 14 panels — DeviceRegistryCard, CashierManagementCard,
 * realtime-subscribed cards, hardware proxies, etc. — mount the instant
 * the user opens /pos/settings. Their effects + realtime channels then
 * compete with the next route's render when the user navigates away,
 * producing the "URL changed but Settings is still here" beat and the
 * app-wide freeze that strands `inert` on #root.
 *
 * This wrapper keeps the TabsContent node in the DOM (so Radix's
 * keyboard/aria contract is preserved) but only renders the heavy
 * children for the active tab. Inactive children unmount cleanly.
 */
function LazyTabsContent({
  value,
  active,
  className,
  children,
}: {
  value: string;
  active: string;
  className?: string;
  children: ReactNode;
}) {
  const isMounted = useRef(false);

  useEffect(() => {
    if (active === value) {
      isMounted.current = true;
    }
  }, [active, value]);

  return (
    <TabsContent value={value} className={className}>
      {active === value ? children : null}
    </TabsContent>
  );
}
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { usePOSRegisters } from "@/hooks/pos/usePOSRegisters";
import { usePOSDiscounts } from "@/hooks/pos/usePOSDiscounts";
import { usePOSSettings } from "@/hooks/pos/usePOSSettings";
import { useReceiptSettings } from "@/hooks/useReceiptSettings";
import { useCurrency } from "@/hooks/useCurrency";
import { CreateRegisterDialog } from "@/components/pos/CreateRegisterDialog";
// DeviceRegistryCard intentionally NOT imported here — Wave 8 removed the
// embedded hardware editor from POS settings. The tab now renders a
// redirect-only CTA pointing at Platform → Hardware. The architecture
// test `src/test/architecture/pos-settings-no-hardware-editor.test.ts`
// guards against accidental re-introduction.
import { LoyaltySettingsCard } from "@/components/pos/LoyaltySettingsCard";
import { OfflineSettingsCard } from "@/components/pos/OfflineSettingsCard";
import { CashierManagementCard } from "@/components/pos/CashierManagementCard";
import { SecuritySettingsCard } from "@/components/pos/SecuritySettingsCard";
import { OverrideMatrixSettings } from "@/components/pos/OverrideMatrixSettings";
import { POSVoidReasonsCard } from "@/components/pos/POSVoidReasonsCard";
import { POSReturnReasonsCard } from "@/components/pos/POSReturnReasonsCard";
import { RestaurantSettingsCard } from "@/components/pos/RestaurantSettingsCard";
import { POSDataResetTool } from "@/components/pos/POSDataResetTool";
import { DenominationSettingsCard } from "@/components/pos/DenominationSettingsCard";
import { RescueSessionAlert } from "@/components/pos/RescueSessionAlert";
import { PaymentMethodRow } from "@/components/pos/PaymentMethodRow";
import { EditRegisterDialog } from "@/components/pos/EditRegisterDialog";
import { SoundSettingsCard } from "@/components/pos/SoundSettingsCard";
import { useSubscriptionAccess } from "@/contexts/SubscriptionAccessContext";
import { PermissionGate } from "@/components/common/PermissionGate";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useTestPrintReceipt } from "@/hooks/pos/useTestPrintReceipt";
import { useHardwareProxy } from "@/hooks/hardware/useHardwareProxy";
import { useActivePOSRegister } from "@/hooks/pos/useActivePOSRegister";
import { useResolvedPrintPolicyWithDevice } from "@/hooks/useDocumentPrintPolicies";
import { ResolvedPrintPolicyPanel } from "@/components/settings/ResolvedPrintPolicyPanel";
import { PrinterProfilePaperMismatchAlert } from "@/components/pos/PrinterProfilePaperMismatchAlert";
import { ScopeOwnershipBadge } from "@/components/pos/ScopeOwnershipBadge";
import { useBranch } from "@/contexts/BranchContext";
import { usePOSOverseer } from "@/hooks/pos/usePOSOverseer";
import { toast } from "sonner";
import { 
  Settings, 
  Monitor, 
  Receipt, 
  Percent, 
  Printer,
  CreditCard,
  Plus,
  Trash2,
  Edit,
  Power,
  PowerOff,
  Banknote,
  Smartphone,
  Building,
  FileText,
  Wallet,
  Save,
  Loader2,
  Gift,
  Wifi,
  UserCog,
  Shield,
  UtensilsCrossed,
  AlertOctagon,
  Coins,
  Volume2,
  ScanLine
} from "lucide-react";
import POSBarcodeSettings from "@/pages/pos/POSBarcodeSettings";

const iconMap: Record<string, React.ElementType> = {
  Banknote,
  CreditCard,
  Smartphone,
  Building,
  FileText,
  Wallet,
};

const VALID_POS_TABS = new Set([
  "registers","cashiers","hardware","discounts","receipts",
  "payments","loyalty","offline","security","restaurant","cash","sound","barcodes","danger",
]);

const getValidPOSTab = (tab: string | null) => (
  tab && VALID_POS_TABS.has(tab) ? tab : "registers"
);

export default function POSSettings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState(() => getValidPOSTab(searchParams.get("tab")));
  useEffect(() => {
    setActiveTab(getValidPOSTab(searchParams.get("tab")));
  }, [searchParams]);

  const handleTabChange = (nextTab: string) => {
    const validTab = getValidPOSTab(nextTab);
    setActiveTab(validTab);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("tab", validTab);
      return next;
    }, { replace: true });
  };
  // Scroll active tab content into view when the user switches tabs.
  // The tab strip wraps to multiple rows on narrow viewports and can push
  // the content below the fold, making the swap look like a no-op.
  const tabContentRef = useRef<HTMLDivElement | null>(null);
  const didMountTabRef = useRef(false);
  useEffect(() => {
    if (!didMountTabRef.current) {
      didMountTabRef.current = true;
      return;
    }
    tabContentRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [activeTab]);
  const { registers, updateRegister, deleteRegister } = usePOSRegisters();
  const { discounts, createDiscount, updateDiscount, deleteDiscount } = usePOSDiscounts();
  const { 
    receiptSettings, 
    updateReceiptSettings, 
    allPaymentMethods, 
    updatePaymentMethod,
    initializePaymentMethods,
    cashRoundingSettings,
    updateCashRounding,
    isLoading: settingsLoading 
  } = usePOSSettings();
  // R1.5 — surface inherit/override state for each POS receipt override.
  // We compare each local POS field against the global company-level value
  // and let the user reset back to inheritance with one click.
  const { settings: globalReceiptSettings } = useReceiptSettings();
  const { currentOrg } = useOrganization();
  const { formatCurrency, getCurrencySymbol } = useCurrency();
  const { isReadOnly, openUpgradeModal } = useSubscriptionAccess();
  const { currentBranch } = useBranch();
  const { canOversee } = usePOSOverseer();
  // Wave 8: removed `selectedHardwareRegisterId` — the hardware tab no
  // longer renders a per-register editor; bindings are managed at
  // Platform → Hardware (which already handles scope via DeviceAssignments).
  const [showCreateRegister, setShowCreateRegister] = useState(false);
  const [showDeleteRegisterDialog, setShowDeleteRegisterDialog] = useState(false);
  const [deleteRegisterId, setDeleteRegisterId] = useState<string | null>(null);
  const [showDeleteDiscountDialog, setShowDeleteDiscountDialog] = useState(false);
  const [deleteDiscountId, setDeleteDiscountId] = useState<string | null>(null);
  const [editRegister, setEditRegister] = useState<typeof registers[0] | null>(null);
  const [newDiscount, setNewDiscount] = useState({
    name: "",
    type: "percentage" as "percentage" | "fixed",
    value: "",
    minPurchase: "",
  });

  const handleCreateDiscount = () => {
    if (!newDiscount.name || !newDiscount.value) {
      toast.error("Please provide a name and value for the discount.");
      return;
    }
    createDiscount.mutate({
      name: newDiscount.name,
      discount_type: newDiscount.type,
      value: parseFloat(newDiscount.value),
      min_purchase_amount: newDiscount.minPurchase ? parseFloat(newDiscount.minPurchase) : null,
      is_active: true,
      requires_approval: false,
      approval_role: null,
      valid_from: null,
      valid_to: null,
    }, {
      onSuccess: () => {
        toast.success(`Discount "${newDiscount.name}" created.`);
        setNewDiscount({
          name: "",
          type: "percentage",
          value: "",
          minPurchase: "",
        });
      }
    });
  };

  const handleToggleRegister = (registerId: string, isActive: boolean) => {
    updateRegister.mutate({ id: registerId, is_active: isActive });
  };

  const handlePaymentMethodToggle = (methodKey: string, isEnabled: boolean) => {
    updatePaymentMethod.mutate({
      method_key: methodKey,
      is_enabled: isEnabled,
    });
  };

  const localReceiptSettings = (receiptSettings || {}) as Partial<import("@/types/receipt").ExtendedReceiptSettings>;
  const [receiptSettingsDirty, setReceiptSettingsDirty] = useState(false);

  const handleReceiptSettingChange = (key: string, value: any) => {
    updateReceiptSettings.mutate({ [key]: value } as any);
    setReceiptSettingsDirty(true);
  };

  const handleSaveReceiptSettings = () => {
    // The mutation is already called on change, this is just for user feedback
    toast.success("POS receipt settings saved.");
    setReceiptSettingsDirty(false);
  };

  const { activeRegisterId } = useActivePOSRegister();
  const activeRegister = registers.find((r) => r.id === activeRegisterId) || null;
  const { sendTestPrint, isPrinting: isTestPrinting, lastResolved: lastTestResolved } = useTestPrintReceipt();
  // Wave 10 — device-aware policy resolution so the receipt-settings panel
  // can surface the EXACT device that will print, not just the abstract
  // printer profile id. The base policy fields are unchanged.
  const { policy: resolvedReceiptPolicy, device: resolvedReceiptDevice } = useResolvedPrintPolicyWithDevice(currentOrg?.id, activeRegister?.branch_id, 'pos_receipt');

  const handlePOSTestPrint = () => {
    if (!activeRegister?.id) {
      toast.error("No active register found to test print.");
      return;
    }
    sendTestPrint({ receiptSettings: localReceiptSettings, registerName: activeRegister.register_name });
  };

  const inheritIndicator = (key: keyof typeof globalReceiptSettings) => {
    const isOverridden = localReceiptSettings[key] != null && localReceiptSettings[key] !== globalReceiptSettings?.[key];
    if (isOverridden) {
      return (
        <Badge variant="outline" className="text-xs">
          Overridden ·
          <button
            className="ml-1 text-primary hover:underline"
            onClick={() => handleReceiptSettingChange(key, null)}
          >
            reset
          </button>
        </Badge>
      );
    }
    return <Badge variant="secondary" className="text-xs">Inherited</Badge>;
  };

  // Lifecycle hardening — force every Settings-owned dialog closed on
  // unmount. POSSettings owns four Radix portals (CreateRegisterDialog,
  // EditRegisterDialog, two ConfirmDeleteDialogs). If any of them is open
  // when the user navigates away (`/pos/settings` → `/pos`, `/pos/reports`,
  // dashboard, …), the page tree is unmounted with the portal still in
  // `data-state="open"`, which strands `aria-hidden`/`inert` on `#root`
  // and `pointer-events:none` on `<body>` — the exact "URL changes but
  // UI is stuck on Settings" beat. Flipping every dialog's open state to
  // `false` during the cleanup pass lets Radix run its own teardown while
  // the portal host is still mounted.
  useEffect(() => {
    return () => {
      setShowCreateRegister(false);
      setShowDeleteRegisterDialog(false);
      setShowDeleteDiscountDialog(false);
      setEditRegister(null);
    };
  }, []);

  return (
    <div className="space-y-4 sm:space-y-6">
        {/* Rescue Session Alert */}
        <RescueSessionAlert />

        {/* Header */}
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold">POS Settings</h1>
          <p className="text-sm sm:text-base text-muted-foreground">Configure registers, discounts, and receipt settings</p>
        </div>

        <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-4 sm:space-y-6">
          <TabsList className="flex-wrap h-auto gap-1 w-full justify-start p-1 sticky top-0 z-10 bg-background">


            <TabsTrigger value="registers" className="text-xs sm:text-sm px-2 sm:px-3">
              <Monitor className="h-3 w-3 sm:h-4 sm:w-4 sm:mr-2" />
              <span className="hidden sm:inline">Registers</span>
            </TabsTrigger>
            <TabsTrigger value="cashiers" className="text-xs sm:text-sm px-2 sm:px-3">
              <UserCog className="h-3 w-3 sm:h-4 sm:w-4 sm:mr-2" />
              <span className="hidden sm:inline">Cashiers</span>
            </TabsTrigger>
            <TabsTrigger value="hardware" className="text-xs sm:text-sm px-2 sm:px-3">
              <Printer className="h-3 w-3 sm:h-4 sm:w-4 sm:mr-2" />
              <span className="hidden sm:inline">Hardware</span>
            </TabsTrigger>
            <TabsTrigger value="discounts" className="text-xs sm:text-sm px-2 sm:px-3">
              <Percent className="h-3 w-3 sm:h-4 sm:w-4 sm:mr-2" />
              <span className="hidden sm:inline">Discounts</span>
            </TabsTrigger>
            <TabsTrigger value="receipts" className="text-xs sm:text-sm px-2 sm:px-3">
              <Receipt className="h-3 w-3 sm:h-4 sm:w-4 sm:mr-2" />
              <span className="hidden sm:inline">Receipts</span>
            </TabsTrigger>
            <TabsTrigger value="payments" className="text-xs sm:text-sm px-2 sm:px-3">
              <CreditCard className="h-3 w-3 sm:h-4 sm:w-4 sm:mr-2" />
              <span className="hidden sm:inline">Payments</span>
            </TabsTrigger>
            <TabsTrigger value="loyalty" className="text-xs sm:text-sm px-2 sm:px-3">
              <Gift className="h-3 w-3 sm:h-4 sm:w-4 sm:mr-2" />
              <span className="hidden sm:inline">Loyalty</span>
            </TabsTrigger>
            <TabsTrigger value="offline" className="text-xs sm:text-sm px-2 sm:px-3">
              <Wifi className="h-3 w-3 sm:h-4 sm:w-4 sm:mr-2" />
              <span className="hidden sm:inline">Offline</span>
            </TabsTrigger>
            <TabsTrigger value="security" className="text-xs sm:text-sm px-2 sm:px-3">
              <Shield className="h-3 w-3 sm:h-4 sm:w-4 sm:mr-2" />
              <span className="hidden sm:inline">Security</span>
            </TabsTrigger>
            <TabsTrigger value="restaurant" className="text-xs sm:text-sm px-2 sm:px-3">
              <UtensilsCrossed className="h-3 w-3 sm:h-4 sm:w-4 sm:mr-2" />
              <span className="hidden sm:inline">Restaurant</span>
            </TabsTrigger>
            <TabsTrigger value="cash" className="text-xs sm:text-sm px-2 sm:px-3">
              <Coins className="h-3 w-3 sm:h-4 sm:w-4 sm:mr-2" />
              <span className="hidden sm:inline">Cash</span>
            </TabsTrigger>
            <TabsTrigger value="sound" className="text-xs sm:text-sm px-2 sm:px-3">
              <Volume2 className="h-3 w-3 sm:h-4 sm:w-4 sm:mr-2" />
              <span className="hidden sm:inline">Sound</span>
            </TabsTrigger>
            <TabsTrigger value="barcodes" className="text-xs sm:text-sm px-2 sm:px-3">
              <ScanLine className="h-3 w-3 sm:h-4 sm:w-4 sm:mr-2" />
              <span className="hidden sm:inline">Barcodes</span>
            </TabsTrigger>
            <TabsTrigger value="danger" className="text-xs sm:text-sm px-2 sm:px-3 text-destructive">
              <AlertOctagon className="h-3 w-3 sm:h-4 sm:w-4 sm:mr-2" />
              <span className="hidden sm:inline">Danger Zone</span>
            </TabsTrigger>
          </TabsList>
          <div ref={tabContentRef} aria-hidden />

          {/* Registers Tab */}
          <LazyTabsContent active={activeTab} value="registers" className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
              <div>
                <h2 className="text-base sm:text-lg font-semibold">POS Registers</h2>
                <p className="text-xs sm:text-sm text-muted-foreground">
                  {currentBranch?.id
                    ? `Showing registers for branch: ${currentBranch.name}`
                    : canOversee
                      ? "Overseer view — registers across all branches (read-only for foreign branches)"
                      : "Select a branch to view its registers"}
                </p>
              </div>
              <PermissionGate permission="managePOS">
                <Button size="sm"
                  onClick={() => setShowCreateRegister(true)}
                  disabled={!currentBranch?.id}
                  title={!currentBranch?.id ? "Switch into a branch to add a register" : undefined}
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add Register
                </Button>
              </PermissionGate>
            </div>

            <div className="grid gap-3 sm:gap-4">
              {registers.length === 0 ? (
                <Card>
                  <CardContent className="py-8 sm:py-12 text-center text-muted-foreground">
                    <Monitor className="h-10 w-10 sm:h-12 sm:w-12 mx-auto mb-3 sm:mb-4 opacity-50" />
                    <p className="text-sm">No registers configured yet</p>
                    <PermissionGate permission="managePOS">
                      <Button variant="link"
                        className="mt-2 text-sm"
                        onClick={() => setShowCreateRegister(true)}
                        disabled={!currentBranch?.id}
                      >
                        Create your first register
                      </Button>
                    </PermissionGate>
                  </CardContent>
                </Card>
              ) : (
                registers.map((register) => {
                  // Operator-visible scope cue: a register from another
                  // branch should be visually flagged so an overseer
                  // browsing in HQ mode does not mis-edit it. Server-side
                  // RLS + `assert_pos_caller_branch_access` are still the
                  // authority — this is operator UX, not enforcement.
                  const isForeignBranch =
                    !!currentBranch?.id &&
                    register.branch_id !== currentBranch.id;
                  const isOverseerReadOnly =
                    !currentBranch?.id &&
                    canOversee &&
                    !!register.branch_id;
                  const mutateLocked = isForeignBranch || isOverseerReadOnly;
                  return (
                    <Card key={register.id} className={mutateLocked ? "opacity-90" : undefined}>
                      <CardContent className="flex flex-col sm:flex-row sm:items-center justify-between p-3 sm:p-4 gap-3">
                        <div className="flex items-center gap-3 sm:gap-4">
                          <div className={`p-2 sm:p-3 rounded-lg flex-shrink-0 ${register.is_active ? 'bg-green-100 dark:bg-green-900/30' : 'bg-muted'}`}>
                            <Monitor className={`h-4 w-4 sm:h-5 sm:w-5 ${register.is_active ? 'text-green-600' : 'text-muted-foreground'}`} />
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <h3 className="font-medium text-sm sm:text-base truncate">{register.register_name}</h3>
                              <ScopeOwnershipBadge
                                ownerBranchId={register.branch_id}
                                ownerBranchName={register.branch?.name ?? null}
                                activeBranchId={currentBranch?.id ?? null}
                              />
                            </div>
                            <p className="text-xs sm:text-sm text-muted-foreground">Code: {register.register_code}</p>
                          </div>
                        </div>
                        <div className="flex items-center justify-between sm:justify-end gap-3 sm:gap-4">
                          <Badge variant={register.is_active ? "default" : "secondary"} className="text-xs">
                            {register.is_active ? "Active" : "Inactive"}
                          </Badge>
                          <div className="flex items-center gap-2">
                            <Switch
                              checked={register.is_active}
                              onCheckedChange={(checked) => isReadOnly ? openUpgradeModal("pos") : handleToggleRegister(register.id, checked)}
                              disabled={isReadOnly || mutateLocked}
                            />
                            <PermissionGate permission="managePOS">
                              <Button variant="ghost"
                                size="icon"
                                className="h-8 w-8"
                                disabled={mutateLocked}
                                title={mutateLocked ? "Switch into the owning branch to edit this register" : undefined}
                                onClick={() => setEditRegister(register)}
                              >
                                <Edit className="h-4 w-4" />
                              </Button>
                              <Button variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-destructive hover:text-destructive"
                                disabled={mutateLocked}
                                title={mutateLocked ? "Switch into the owning branch to delete this register" : undefined}
                                onClick={() => {
                                  setDeleteRegisterId(register.id);
                                  setShowDeleteRegisterDialog(true);
                                }}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            </PermissionGate>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })
              )}
            </div>
          </LazyTabsContent>

          {/* Cashiers Tab */}
          <LazyTabsContent active={activeTab} value="cashiers">
            <CashierManagementCard />
          </LazyTabsContent>

          {/* Restaurant Tab */}
          <LazyTabsContent active={activeTab} value="restaurant">
            <RestaurantSettingsCard />
          </LazyTabsContent>

          {/* Hardware Tab */}
          <LazyTabsContent active={activeTab} value="discounts" className="space-y-4 sm:space-y-6">
            <Card>
              <CardHeader className="p-4 sm:p-6">
                <CardTitle className="text-base sm:text-lg">Create Discount</CardTitle>
                <CardDescription className="text-xs sm:text-sm">Add preset discounts for quick application</CardDescription>
              </CardHeader>
              <CardContent className="p-4 sm:p-6 pt-0 sm:pt-0 space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
                  <div className="space-y-2">
                    <Label className="text-sm">Discount Name</Label>
                    <Input
                      placeholder="e.g., Senior Discount"
                      value={newDiscount.name}
                      onChange={(e) => setNewDiscount(prev => ({ ...prev, name: e.target.value }))}
                      className="text-sm"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label className="text-sm">Type</Label>
                    <Select
                      value={newDiscount.type}
                      onValueChange={(v) => setNewDiscount(prev => ({ ...prev, type: v as "percentage" | "fixed" }))}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="percentage">Percentage (%)</SelectItem>
                        <SelectItem value="fixed">Fixed Amount ({getCurrencySymbol()})</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Value</Label>
                    <Input
                      type="number"
                      placeholder={newDiscount.type === "percentage" ? "10" : "5.00"}
                      value={newDiscount.value}
                      onChange={(e) => setNewDiscount(prev => ({ ...prev, value: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Min. Purchase (Optional)</Label>
                    <Input
                      type="number"
                      placeholder="0.00"
                      value={newDiscount.minPurchase}
                      onChange={(e) => setNewDiscount(prev => ({ ...prev, minPurchase: e.target.value }))}
                    />
                  </div>
                </div>
                <Button onClick={handleCreateDiscount} disabled={createDiscount.isPending}>
                  <Plus className="h-4 w-4 mr-2" />
                  Create Discount
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Active Discounts</CardTitle>
                <CardDescription>Manage your discount presets</CardDescription>
              </CardHeader>
              <CardContent>
                {discounts.length === 0 ? (
                  <p className="text-center text-muted-foreground py-8">No discounts configured</p>
                ) : (
                  <div className="space-y-3">
                    {discounts.map((discount) => (
                      <div key={discount.id} className="flex items-center justify-between p-3 border rounded-lg">
                        <div className="flex items-center gap-3">
                          <div className="p-2 rounded-lg bg-primary/10">
                            <Percent className="h-4 w-4 text-primary" />
                          </div>
                          <div>
                            <p className="font-medium">{discount.name}</p>
                            <p className="text-sm text-muted-foreground">
                              {discount.discount_type === "percentage" 
                                ? `${discount.value}% off`
                                : `${formatCurrency(discount.value)} off`
                              }
                              {discount.min_purchase_amount && ` (Min: ${formatCurrency(discount.min_purchase_amount)})`}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={discount.is_active}
                            onCheckedChange={(checked) => {
                              updateDiscount.mutate({ id: discount.id, is_active: checked });
                            }}
                          />
                          <Button
                            variant="ghost"
                            size="icon"
                            className="text-destructive hover:text-destructive"
                            onClick={() => {
                              setDeleteDiscountId(discount.id);
                              setShowDeleteDiscountDialog(true);
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </LazyTabsContent>

          {/* Receipts Tab - Enhanced with Paper Size */}
          <LazyTabsContent active={activeTab} value="receipts">
            <Card>
              <CardHeader>
                <CardTitle>POS Receipt Overrides</CardTitle>
                <CardDescription>
                  Override specific receipt settings for POS terminals. All other settings are inherited from{" "}
                  <a href="/settings" className="text-primary underline underline-offset-2 hover:text-primary/80">
                    Settings → Receipts
                  </a>.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                {settingsLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <>
                    {/* Info banner */}
                    <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm text-muted-foreground">
                      <p>
                        <strong className="text-foreground">How it works:</strong> POS receipts inherit your global receipt configuration (branding, sections, content). 
                        Use the settings below to override only POS-specific behavior like paper size and auto-print.
                      </p>
                    </div>

                    {/* Paper Size Selection */}
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <Label className="text-base font-medium">Paper Size</Label>
                        {inheritIndicator('paper_size')}
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        <Button
                          variant={localReceiptSettings.paper_size === '40mm' ? "default" : "outline"}
                          className="flex flex-col h-auto py-3 gap-1"
                          onClick={() => handleReceiptSettingChange('paper_size', '40mm')}
                        >
                          <span className="text-sm font-medium">40mm</span>
                          <span className="text-xs text-muted-foreground">24 columns</span>
                        </Button>
                        <Button
                          variant={localReceiptSettings.paper_size === '58mm' ? "default" : "outline"}
                          className="flex flex-col h-auto py-3 gap-1"
                          onClick={() => handleReceiptSettingChange('paper_size', '58mm')}
                        >
                          <span className="text-sm font-medium">58mm</span>
                          <span className="text-xs text-muted-foreground">32 columns</span>
                        </Button>
                        <Button
                          variant={localReceiptSettings.paper_size === '80mm' ? "default" : "outline"}
                          className="flex flex-col h-auto py-3 gap-1"
                          onClick={() => handleReceiptSettingChange('paper_size', '80mm')}
                        >
                          <span className="text-sm font-medium">80mm</span>
                          <span className="text-xs text-muted-foreground">48 columns</span>
                        </Button>
                        <Button
                          variant={localReceiptSettings.paper_size === 'A4' ? "default" : "outline"}
                          className="flex flex-col h-auto py-3 gap-1"
                          onClick={() => handleReceiptSettingChange('paper_size', 'A4')}
                        >
                          <span className="text-sm font-medium">A4</span>
                          <span className="text-xs text-muted-foreground">Full page</span>
                        </Button>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        Column counts assume ESC/POS Font A. Font B fits more columns; pick the size that matches your printer.
                      </p>
                      <PrinterProfilePaperMismatchAlert
                        deviceAssignmentId={resolvedReceiptDevice?.id ?? null}
                        selectedPaper={localReceiptSettings.paper_size}
                      />
                      {/* Wave 10 — show the resolved device so the operator
                          knows exactly where the next receipt will land. The
                          label sources from device_assignments.display_name,
                          falling back to the device role + transport. */}
                      {resolvedReceiptPolicy?.role_code ? (
                        <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
                          <span className="text-muted-foreground">Will print to: </span>
                          {resolvedReceiptDevice ? (
                            <span className="font-medium">
                              {resolvedReceiptDevice.display_name ?? `${resolvedReceiptDevice.role} (${resolvedReceiptDevice.transport})`}
                            </span>
                          ) : (
                            <span className="font-medium text-amber-600 dark:text-amber-400">
                              The configured device no longer exists — bind one in Hardware → Devices.
                            </span>
                          )}
                        </div>
                      ) : null}
                    </div>

                    <Separator />

                    <div className="grid gap-4">
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-medium">Print Receipt After Sale</p>
                          <p className="text-sm text-muted-foreground">Automatically print receipt when sale completes</p>
                        </div>
                        <div className="flex items-center gap-3">
                          {inheritIndicator('auto_print_receipt')}
                          <Switch
                            checked={localReceiptSettings.auto_print_receipt}
                            onCheckedChange={(checked) => handleReceiptSettingChange('auto_print_receipt', checked)}
                          />
                        </div>
                      </div>
                      <Separator />

                      {/* R1 — Split: font size and line spacing are independent */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <Label className="font-medium">Font Size</Label>
                            {inheritIndicator('font_size')}
                          </div>
                          <Select
                            value={localReceiptSettings.font_size || 'medium'}
                            onValueChange={(value) => handleReceiptSettingChange('font_size', value)}
                          >
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="small">Small</SelectItem>
                              <SelectItem value="medium">Medium</SelectItem>
                              <SelectItem value="large">Large</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <div className="flex items-center justify-between">
                            <Label className="font-medium">Line Spacing</Label>
                            {inheritIndicator('line_spacing')}
                          </div>
                          <Select
                            value={localReceiptSettings.line_spacing || 'normal'}
                            onValueChange={(value) => handleReceiptSettingChange('line_spacing', value)}
                          >
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="compact">Compact</SelectItem>
                              <SelectItem value="normal">Normal</SelectItem>
                              <SelectItem value="relaxed">Relaxed</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>

                      <Separator />
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <Label className="font-medium">Item Display Format</Label>
                          {inheritIndicator('item_display_format')}
                        </div>
                        <Select
                          value={localReceiptSettings.item_display_format || 'single-line'}
                          onValueChange={(value) => handleReceiptSettingChange('item_display_format', value)}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="single-line">Compact (one line per item)</SelectItem>
                            <SelectItem value="two-lines">Detailed (name on first line, details below)</SelectItem>
                            <SelectItem value="tabular">Tabular (4-column with SKU row)</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>

                      {/* R1 — 7 whitelisted fields previously missing from POS overrides */}
                      <Separator />
                      <p className="text-xs text-muted-foreground -mb-2">
                        Content overrides — leave blank or unchecked to inherit from global Receipt Settings.
                        Each field shows <em>inherited</em> when it matches the global value, or <em>overridden · reset</em>
                        when this register is shadowing the global setting.
                      </p>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <Label>Receipt Header (POS override)</Label>
                          {inheritIndicator('receipt_header')}
                        </div>
                        <Textarea
                          rows={2}
                          placeholder="Inherits global header"
                          value={localReceiptSettings.receipt_header || ''}
                          onChange={(e) => handleReceiptSettingChange('receipt_header', e.target.value)}
                        />
                      </div>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between">
                          <Label>Receipt Footer (POS override)</Label>
                          {inheritIndicator('receipt_footer')}
                        </div>
                        <Textarea
                          rows={2}
                          placeholder="Inherits global footer"
                          value={localReceiptSettings.receipt_footer || ''}
                          onChange={(e) => handleReceiptSettingChange('receipt_footer', e.target.value)}
                        />
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="flex items-center justify-between rounded-md border p-3">
                          <div className="flex flex-col">
                            <Label className="text-sm">Show Cashier Name</Label>
                            {inheritIndicator('show_cashier_name')}
                          </div>
                          <Switch
                            checked={!!localReceiptSettings.show_cashier_name}
                            onCheckedChange={(checked) => handleReceiptSettingChange('show_cashier_name', checked)}
                          />
                        </div>
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <Label className="text-sm">Cashier Label</Label>
                            {inheritIndicator('cashier_label_format')}
                          </div>
                          <Select
                            value={localReceiptSettings.cashier_label_format || 'cashier'}
                            onValueChange={(value) => handleReceiptSettingChange('cashier_label_format', value)}
                          >
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="cashier">Cashier:</SelectItem>
                              <SelectItem value="served_by">Served by:</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="flex items-center justify-between rounded-md border p-3">
                          <div className="flex flex-col">
                            <Label className="text-sm">Show Item SKU</Label>
                            {inheritIndicator('show_item_sku')}
                          </div>
                          <Switch
                            checked={!!localReceiptSettings.show_item_sku}
                            onCheckedChange={(checked) => handleReceiptSettingChange('show_item_sku', checked)}
                          />
                        </div>
                        <div className="flex items-center justify-between rounded-md border p-3">
                          <div className="flex flex-col">
                            <Label className="text-sm">Show Tax Breakdown</Label>
                            {inheritIndicator('show_tax_breakdown')}
                          </div>
                          <Switch
                            checked={!!localReceiptSettings.show_tax_breakdown}
                            onCheckedChange={(checked) => handleReceiptSettingChange('show_tax_breakdown', checked)}
                          />
                        </div>
                        <div className="flex items-center justify-between rounded-md border p-3 sm:col-span-2">
                          <div className="flex flex-col">
                            <Label className="text-sm">Show "You Saved" Line</Label>
                            {inheritIndicator('show_savings')}
                          </div>
                          <Switch
                            checked={!!localReceiptSettings.show_savings}
                            onCheckedChange={(checked) => handleReceiptSettingChange('show_savings', checked)}
                          />
                        </div>
                      </div>
                    </div>
                    
                    <div className="flex flex-col sm:flex-row gap-2">
                      <Button 
                        onClick={handleSaveReceiptSettings}
                        disabled={!receiptSettingsDirty || updateReceiptSettings.isPending}
                      >
                        {updateReceiptSettings.isPending ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <Save className="h-4 w-4 mr-2" />
                        )}
                        Save POS Overrides
                      </Button>
                      <Button
                        variant="outline"
                        onClick={handlePOSTestPrint}
                        disabled={isTestPrinting}
                      >
                        {isTestPrinting ? (
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        ) : (
                          <Printer className="h-4 w-4 mr-2" />
                        )}
                        Send Test Print
                      </Button>
                    </div>
                    <ResolvedPrintPolicyPanel
                      resolved={lastTestResolved}
                      expectedColumns={null}
                    />
                  </>
                )}
              </CardContent>
            </Card>
          </LazyTabsContent>

          {/* Payments Tab - With GL Account Linkage */}
          <LazyTabsContent active={activeTab} value="payments">
            <Card>
              <CardHeader>
                <CardTitle>Payment Methods</CardTitle>
                <CardDescription>Configure accepted payment types and their GL account mappings for accurate accounting</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {settingsLoading ? (
                  <div className="flex items-center justify-center py-8">
                    <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <>
                    <div className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm text-muted-foreground">
                      <p>
                        <strong className="text-foreground">GL Account Mapping:</strong> Link each payment method to the GL account where received funds should be debited.
                        Cash → Cash account, Card → Bank account, etc. If no account is set, the system default cash account is used.
                      </p>
                    </div>
                    {allPaymentMethods.map((method) => {
                      const IconComponent = iconMap[method.icon || "CreditCard"] || CreditCard;
                      return (
                        <PaymentMethodRow
                          key={method.method_key}
                          method={method}
                          IconComponent={IconComponent}
                          onToggle={handlePaymentMethodToggle}
                          onAccountChange={(methodKey, accountId) => {
                            updatePaymentMethod.mutate({
                              method_key: methodKey,
                              debit_account_id: accountId,
                            });
                          }}
                          isPending={updatePaymentMethod.isPending}
                        />
                      );
                    })}
                  </>
                )}
              </CardContent>
            </Card>

            {/* Cash Rounding */}
            <Card className="mt-4">
              <CardHeader>
                <CardTitle className="text-base">Cash Rounding</CardTitle>
                <CardDescription>Automatically round cash payment totals to the nearest increment</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="font-medium text-sm">Enable Cash Rounding</p>
                    <p className="text-xs text-muted-foreground">Round cash totals to avoid small change</p>
                  </div>
                  <Switch
                    checked={cashRoundingSettings.enabled}
                    onCheckedChange={(enabled) => updateCashRounding.mutate({ ...cashRoundingSettings, enabled })}
                  />
                </div>
                {cashRoundingSettings.enabled && (
                  <div className="space-y-2">
                    <Label>Rounding Precision</Label>
                    <Select
                      value={cashRoundingSettings.precision.toString()}
                      onValueChange={(v) => updateCashRounding.mutate({ ...cashRoundingSettings, precision: parseFloat(v) })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="0.05">0.05</SelectItem>
                        <SelectItem value="0.10">0.10</SelectItem>
                        <SelectItem value="0.50">0.50</SelectItem>
                        <SelectItem value="1">1.00</SelectItem>
                        <SelectItem value="5">5.00</SelectItem>
                        <SelectItem value="10">10.00</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Example: {getCurrencySymbol()}10.03 → {getCurrencySymbol()}{(Math.round(10.03 / cashRoundingSettings.precision) * cashRoundingSettings.precision).toFixed(2)}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          </LazyTabsContent>

          {/* Hardware Tab — Wave 8: redirect-only.
              The embedded `DeviceRegistryCard` editor has moved to
              Platform → Hardware. Keeping a single primary CTA here
              prevents operators from editing hardware bindings from two
              places and is enforced by an architecture test. */}
          <LazyTabsContent active={activeTab} value="hardware" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Hardware is managed at Platform → Hardware</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">
                  Device registration, role bindings, transports, drivers, and
                  diagnostics now live in a platform-owned surface so any module
                  (Inventory, Warehouse, HR, Manufacturing) can consume the same
                  hardware registry. The legacy editor was removed from POS
                  settings in Wave 8.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Link
                    to="/platform/hardware/devices"
                    className="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:opacity-90"
                  >
                    Open Platform → Hardware
                  </Link>
                  <Link
                    to="/platform/hardware/diagnostics"
                    className="inline-flex items-center justify-center rounded-md border px-4 py-2 text-sm font-medium hover:bg-accent"
                  >
                    View diagnostics
                  </Link>
                </div>
              </CardContent>
            </Card>
          </LazyTabsContent>


          {/* Loyalty Tab */}
          <LazyTabsContent active={activeTab} value="loyalty">
            <LoyaltySettingsCard />
          </LazyTabsContent>

          {/* Offline Tab */}
          <LazyTabsContent active={activeTab} value="offline">
            <OfflineSettingsCard />
          </LazyTabsContent>

          {/* Security Tab */}
          <LazyTabsContent active={activeTab} value="security">
            <div className="space-y-4">
              <SecuritySettingsCard />
              <OverrideMatrixSettings />
              <POSVoidReasonsCard />
              <POSReturnReasonsCard />
            </div>
          </LazyTabsContent>

          {/* Cash / Denomination Tab */}
          <LazyTabsContent active={activeTab} value="cash">
            <DenominationSettingsCard />
          </LazyTabsContent>

          {/* Sound Effects Tab */}
          <LazyTabsContent active={activeTab} value="sound">
            <SoundSettingsCard />
          </LazyTabsContent>

          {/* Danger Zone Tab */}
          <LazyTabsContent active={activeTab} value="barcodes" className="space-y-4">
            <POSBarcodeSettings />
          </LazyTabsContent>

          <LazyTabsContent active={activeTab} value="danger" className="space-y-4">
            <POSDataResetTool />
          </LazyTabsContent>
        </Tabs>

      <CreateRegisterDialog
        open={showCreateRegister}
        onOpenChange={setShowCreateRegister}
      />

      <EditRegisterDialog
        open={!!editRegister}
        onOpenChange={(open) => { if (!open) setEditRegister(null); }}
        register={editRegister}
      />

      {/* Delete Register Confirmation */}
      <ConfirmDeleteDialog
        open={showDeleteRegisterDialog}
        onOpenChange={setShowDeleteRegisterDialog}
        title="Delete Register"
        description="Are you sure you want to delete this register? This action cannot be undone."
        onConfirm={() => {
          if (deleteRegisterId) {
            deleteRegister.mutate(deleteRegisterId);
            setDeleteRegisterId(null);
          }
        }}
      />

      {/* Delete Discount Confirmation */}
      <ConfirmDeleteDialog
        open={showDeleteDiscountDialog}
        onOpenChange={setShowDeleteDiscountDialog}
        title="Delete Discount"
        description="Are you sure you want to delete this discount? This action cannot be undone."
        onConfirm={() => {
          if (deleteDiscountId) {
            deleteDiscount.mutate(deleteDiscountId);
            setDeleteDiscountId(null);
          }
        }}
      />
    </div>
  );
}
