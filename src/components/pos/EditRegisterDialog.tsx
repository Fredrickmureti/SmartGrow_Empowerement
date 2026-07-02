import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import { usePOSRegisters, type POSRegister } from "@/hooks/pos/usePOSRegisters";
import { usePOSSettings } from "@/hooks/pos/usePOSSettings";
import { usePOSProducts } from "@/hooks/pos/usePOSProducts";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Save, Loader2 } from "lucide-react";
import type { Json } from "@/integrations/supabase/types";

interface EditRegisterDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  register: POSRegister | null;
}

export function EditRegisterDialog({ open, onOpenChange, register }: EditRegisterDialogProps) {
  const { updateRegister } = usePOSRegisters();
  const { allPaymentMethods } = usePOSSettings();

  const [form, setForm] = useState({
    register_name: "",
    register_code: "",
    require_cashier_login: false,
    require_manager_for_void: false,
    require_manager_for_discount: false,
    require_manager_for_return: false,
    auto_lock_minutes: 0,
    max_cash_limit: 0,
    void_limit_per_shift: 0,
    receipt_header: "",
    receipt_footer: "",
    auto_open_drawer_on_cash: true,
    auto_open_drawer_on_non_cash: false,
    require_reason_on_no_sale: true,
    confirm_before_drawer_open: false,
    drawer_kick_on_return: false,
    drawer_kick_on_void: false,
    drawer_kick_on_reprint: false,
  });

  const [selectedPaymentMethods, setSelectedPaymentMethods] = useState<string[]>([]);
  const [productScope, setProductScope] = useState<"all" | "by_category" | "specific">("all");
  const [scopeCategories, setScopeCategories] = useState<string[]>([]);
  const { categories } = usePOSProducts();

  useEffect(() => {
    if (register) {
      setForm({
        register_name: register.register_name || "",
        register_code: register.register_code || "",
        require_cashier_login: (register as any).require_cashier_login ?? false,
        require_manager_for_void: (register as any).require_manager_for_void ?? false,
        require_manager_for_discount: (register as any).require_manager_for_discount ?? false,
        require_manager_for_return: (register as any).require_manager_for_return ?? false,
        auto_lock_minutes: (register as any).auto_lock_minutes ?? 0,
        max_cash_limit: (register as any).max_cash_limit ?? 0,
        void_limit_per_shift: (register as any).void_limit_per_shift ?? 0,
        receipt_header: register.receipt_header || "",
        receipt_footer: register.receipt_footer || "",
        auto_open_drawer_on_cash: (register as any).auto_open_drawer_on_cash ?? true,
        auto_open_drawer_on_non_cash: (register as any).auto_open_drawer_on_non_cash ?? false,
        require_reason_on_no_sale: (register as any).require_reason_on_no_sale ?? true,
        confirm_before_drawer_open: (register as any).confirm_before_drawer_open ?? false,
        drawer_kick_on_return: (register as any).drawer_kick_on_return ?? false,
        drawer_kick_on_void: (register as any).drawer_kick_on_void ?? false,
        drawer_kick_on_reprint: (register as any).drawer_kick_on_reprint ?? false,
      });
      // Parse existing default_payment_methods
      const existing = register.default_payment_methods;
      if (Array.isArray(existing)) {
        setSelectedPaymentMethods(existing as string[]);
      } else {
        setSelectedPaymentMethods([]);
      }
      // Parse product scope from settings JSON
      const settings = register.settings as Record<string, unknown> | null;
      setProductScope((settings?.product_scope as "all" | "by_category" | "specific") || "all");
      setScopeCategories((settings?.product_scope_categories as string[]) || []);
    }
  }, [register]);

  const togglePaymentMethod = (methodKey: string) => {
    setSelectedPaymentMethods(prev =>
      prev.includes(methodKey)
        ? prev.filter(k => k !== methodKey)
        : [...prev, methodKey]
    );
  };

  const handleSave = async () => {
    if (!register) return;
    const existingSettings = (register.settings as Record<string, unknown>) || {};
    const newSettings = {
      ...existingSettings,
      product_scope: productScope,
      product_scope_categories: productScope === "by_category" ? scopeCategories : [],
    };
    await updateRegister.mutateAsync({
      id: register.id,
      register_name: form.register_name,
      require_cashier_login: form.require_cashier_login,
      require_manager_for_void: form.require_manager_for_void,
      require_manager_for_discount: form.require_manager_for_discount,
      require_manager_for_return: form.require_manager_for_return,
      auto_lock_minutes: form.auto_lock_minutes || null,
      max_cash_limit: form.max_cash_limit || null,
      void_limit_per_shift: form.void_limit_per_shift || null,
      receipt_header: form.receipt_header || null,
      receipt_footer: form.receipt_footer || null,
      auto_open_drawer_on_cash: form.auto_open_drawer_on_cash,
      auto_open_drawer_on_non_cash: form.auto_open_drawer_on_non_cash,
      require_reason_on_no_sale: form.require_reason_on_no_sale,
      confirm_before_drawer_open: form.confirm_before_drawer_open,
      drawer_kick_on_return: form.drawer_kick_on_return,
      drawer_kick_on_void: form.drawer_kick_on_void,
      drawer_kick_on_reprint: form.drawer_kick_on_reprint,
      default_payment_methods: (selectedPaymentMethods.length > 0 ? selectedPaymentMethods : null) as unknown as Json,
      settings: newSettings as unknown as Json,
    } as any);
    onOpenChange(false);
  };

  if (!register) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Register — {register.register_name}</DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="general" className="space-y-4">
          <TabsList className="w-full">
            <TabsTrigger value="general" className="flex-1 text-xs">General</TabsTrigger>
            <TabsTrigger value="payments" className="flex-1 text-xs">Payments</TabsTrigger>
            <TabsTrigger value="products" className="flex-1 text-xs">Products</TabsTrigger>
            <TabsTrigger value="security" className="flex-1 text-xs">Security</TabsTrigger>
            <TabsTrigger value="receipts" className="flex-1 text-xs">Receipts</TabsTrigger>
            <TabsTrigger value="drawer" className="flex-1 text-xs">Drawer</TabsTrigger>
          </TabsList>

          <TabsContent value="general" className="space-y-4">
            <div className="space-y-2">
              <Label>Register Name</Label>
              <Input
                value={form.register_name}
                onChange={(e) => setForm(prev => ({ ...prev, register_name: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Register Code</Label>
              <Input value={form.register_code} disabled className="bg-muted" />
              <p className="text-xs text-muted-foreground">Code cannot be changed after creation</p>
            </div>
            <Separator />
            <div className="space-y-2">
              <Label>Max Cash Limit</Label>
              <Input
                type="number"
                value={form.max_cash_limit || ""}
                onChange={(e) => setForm(prev => ({ ...prev, max_cash_limit: parseFloat(e.target.value) || 0 }))}
                placeholder="No limit"
              />
              <p className="text-xs text-muted-foreground">Alert when cash in drawer exceeds this amount</p>
            </div>
          </TabsContent>

          <TabsContent value="payments" className="space-y-4">
            <div>
              <p className="text-sm font-medium mb-1">Allowed Payment Methods</p>
              <p className="text-xs text-muted-foreground mb-3">
                Select which payment methods are available on this register. If none are selected, all enabled methods will be available.
              </p>
            </div>
            <div className="space-y-2">
              {allPaymentMethods.map((method) => (
                <label
                  key={method.method_key}
                  className="flex items-center gap-3 p-2 rounded-md border cursor-pointer hover:bg-muted/50 transition-colors"
                >
                  <Checkbox
                    checked={selectedPaymentMethods.includes(method.method_key)}
                    onCheckedChange={() => togglePaymentMethod(method.method_key)}
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{method.display_name}</p>
                    <p className="text-xs text-muted-foreground">{method.method_key}</p>
                  </div>
                  {!method.is_enabled && (
                    <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">Disabled globally</span>
                  )}
                </label>
              ))}
            </div>
            {selectedPaymentMethods.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {selectedPaymentMethods.length} method{selectedPaymentMethods.length !== 1 ? "s" : ""} selected
              </p>
            )}
          </TabsContent>

          <TabsContent value="products" className="space-y-4">
            <div>
              <p className="text-sm font-medium mb-1">Product Availability</p>
              <p className="text-xs text-muted-foreground mb-3">
                Control which products are shown on this register's terminal.
              </p>
            </div>
            <Select
              value={productScope}
              onValueChange={(v) => setProductScope(v as "all" | "by_category" | "specific")}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All products</SelectItem>
                <SelectItem value="by_category">By category</SelectItem>
              </SelectContent>
            </Select>
            {productScope === "by_category" && categories.length > 0 && (
              <div className="space-y-2">
                <Label className="text-xs">Select categories</Label>
                {categories.map((cat) => (
                  <label
                    key={cat}
                    className="flex items-center gap-3 p-2 rounded-md border cursor-pointer hover:bg-muted/50 transition-colors"
                  >
                    <Checkbox
                      checked={scopeCategories.includes(cat)}
                      onCheckedChange={(checked) =>
                        setScopeCategories(prev =>
                          checked ? [...prev, cat] : prev.filter(c => c !== cat)
                        )
                      }
                    />
                    <span className="text-sm">{cat}</span>
                  </label>
                ))}
              </div>
            )}
            {productScope === "by_category" && categories.length === 0 && (
              <p className="text-xs text-muted-foreground">No product categories found. Products need categories assigned first.</p>
            )}
          </TabsContent>

          <TabsContent value="security" className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-sm">Require Cashier Login</p>
                <p className="text-xs text-muted-foreground">Cashier must authenticate with PIN before using register</p>
              </div>
              <Switch
                checked={form.require_cashier_login}
                onCheckedChange={(v) => setForm(prev => ({ ...prev, require_cashier_login: v }))}
              />
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-sm">Manager Approval for Voids</p>
                <p className="text-xs text-muted-foreground">Require manager PIN to void a transaction</p>
              </div>
              <Switch
                checked={form.require_manager_for_void}
                onCheckedChange={(v) => setForm(prev => ({ ...prev, require_manager_for_void: v }))}
              />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-sm">Manager Approval for Discounts</p>
                <p className="text-xs text-muted-foreground">Require manager PIN for manual discounts</p>
              </div>
              <Switch
                checked={form.require_manager_for_discount}
                onCheckedChange={(v) => setForm(prev => ({ ...prev, require_manager_for_discount: v }))}
              />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-sm">Manager Approval for Returns</p>
                <p className="text-xs text-muted-foreground">Require manager PIN to process returns</p>
              </div>
              <Switch
                checked={form.require_manager_for_return}
                onCheckedChange={(v) => setForm(prev => ({ ...prev, require_manager_for_return: v }))}
              />
            </div>
            <Separator />
            <div className="space-y-2">
              <Label>Auto-Lock After (minutes)</Label>
              <Input
                type="number"
                value={form.auto_lock_minutes || ""}
                onChange={(e) => setForm(prev => ({ ...prev, auto_lock_minutes: parseInt(e.target.value) || 0 }))}
                placeholder="Disabled"
              />
              <p className="text-xs text-muted-foreground">Lock register after inactivity (0 = disabled)</p>
            </div>
            <div className="space-y-2">
              <Label>Void Limit Per Shift</Label>
              <Input
                type="number"
                value={form.void_limit_per_shift || ""}
                onChange={(e) => setForm(prev => ({ ...prev, void_limit_per_shift: parseInt(e.target.value) || 0 }))}
                placeholder="Unlimited"
              />
              <p className="text-xs text-muted-foreground">Max number of voids allowed per shift (0 = unlimited)</p>
            </div>
          </TabsContent>

          <TabsContent value="receipts" className="space-y-4">
            <div className="space-y-2">
              <Label>Receipt Header</Label>
              <Textarea
                value={form.receipt_header}
                onChange={(e) => setForm(prev => ({ ...prev, receipt_header: e.target.value }))}
                placeholder="Custom header text for this register's receipts"
                rows={3}
              />
              <p className="text-xs text-muted-foreground">Overrides the global receipt header for this register only</p>
            </div>
            <div className="space-y-2">
              <Label>Receipt Footer</Label>
              <Textarea
                value={form.receipt_footer}
                onChange={(e) => setForm(prev => ({ ...prev, receipt_footer: e.target.value }))}
                placeholder="Custom footer text for this register's receipts"
                rows={3}
              />
              <p className="text-xs text-muted-foreground">Overrides the global receipt footer for this register only</p>
            </div>
          </TabsContent>

          <TabsContent value="drawer" className="space-y-4">
            <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              Controls when the physical cash drawer is kicked. The drawer fires automatically based on the tender mix — cashiers never have to type a reason for a normal sale. No-sale opens and cash movements (add cash, pickup, drop) still require a reason for audit.
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-sm">Auto-open on cash payments</p>
                <p className="text-xs text-muted-foreground">Drawer kicks silently after any sale that includes a cash tender</p>
              </div>
              <Switch
                checked={form.auto_open_drawer_on_cash}
                onCheckedChange={(v) => setForm(prev => ({ ...prev, auto_open_drawer_on_cash: v }))}
              />
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-sm">Auto-open on card / mobile / credit</p>
                <p className="text-xs text-muted-foreground">Off by default — non-cash sales should not open the drawer</p>
              </div>
              <Switch
                checked={form.auto_open_drawer_on_non_cash}
                onCheckedChange={(v) => setForm(prev => ({ ...prev, auto_open_drawer_on_non_cash: v }))}
              />
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-sm">Require reason for no-sale opens</p>
                <p className="text-xs text-muted-foreground">Manual "open drawer" without a sale needs a reason note</p>
              </div>
              <Switch
                checked={form.require_reason_on_no_sale}
                onCheckedChange={(v) => setForm(prev => ({ ...prev, require_reason_on_no_sale: v }))}
              />
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-sm">Confirm before opening drawer</p>
                <p className="text-xs text-muted-foreground">Adds a confirmation prompt — slower, only enable for high-fraud environments</p>
              </div>
              <Switch
                checked={form.confirm_before_drawer_open}
                onCheckedChange={(v) => setForm(prev => ({ ...prev, confirm_before_drawer_open: v }))}
              />
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-sm">Open drawer on cash refund</p>
                <p className="text-xs text-muted-foreground">When refunding a cash sale. Card/mobile refunds never trigger the drawer.</p>
              </div>
              <Switch
                checked={form.drawer_kick_on_return}
                onCheckedChange={(v) => setForm(prev => ({ ...prev, drawer_kick_on_return: v }))}
              />
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-sm">Open drawer on cash void</p>
                <p className="text-xs text-muted-foreground">When voiding a cash sale. Card/mobile voids never trigger the drawer.</p>
              </div>
              <Switch
                checked={form.drawer_kick_on_void}
                onCheckedChange={(v) => setForm(prev => ({ ...prev, drawer_kick_on_void: v }))}
              />
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-sm">Open drawer on reprint</p>
                <p className="text-xs text-muted-foreground">Off by default — reprints rarely need the drawer.</p>
              </div>
              <Switch
                checked={form.drawer_kick_on_reprint}
                onCheckedChange={(v) => setForm(prev => ({ ...prev, drawer_kick_on_reprint: v }))}
              />
            </div>
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200">
              <strong>Hardware note:</strong> some printers (e.g. Star TSP100) can be configured at the printer firmware level to fire the drawer on every print. If your drawer opens on card sales even with this setting off, change the printer's drawer setting to "Disabled" or "Document top" using its utility tool — it cannot be overridden from the browser.
            </div>
          </TabsContent>
        </Tabs>

        <div className="flex justify-end pt-2">
          <Button onClick={handleSave} disabled={updateRegister.isPending}>
            {updateRegister.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            Save Changes
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
