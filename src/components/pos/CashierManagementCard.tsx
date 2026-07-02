import { useState, useEffect, useRef } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { usePOSCashiers, POSCashier } from "@/hooks/pos/usePOSCashiers";
import { usePOSRegisters } from "@/hooks/pos/usePOSRegisters";
import { ScopeOwnershipBadge } from "@/components/pos/ScopeOwnershipBadge";
import { useBranch } from "@/contexts/BranchContext";
import { usePOSOverseer } from "@/hooks/pos/usePOSOverseer";
import {
  Plus,
  UserCog,
  MoreHorizontal,
  Pencil,
  Key,
  Power,
  PowerOff,
  Trash2,
  Monitor,
  Loader2,
  Shield,
  ShieldOff,
} from "lucide-react";

export function CashierManagementCard() {
  const id = useRef(`CashierManagementCard-${Date.now()}-${Math.random()}`).current;
  console.log(`[LIFECYCLE] CashierManagementCard RENDERING (${id})`);

  const { cashiers, isLoadingCashiers, availableUsers, createCashier, updateCashier, toggleCashierStatus, setCashierPin, deleteCashier } = usePOSCashiers();
  const { registers } = usePOSRegisters();
  const { currentBranch, branches } = useBranch();
  const { canOversee } = usePOSOverseer();
  const branchNameById = new Map(branches.map((b) => [b.id, b.name]));

  const [showAddDialog, setShowAddDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showPinDialog, setShowPinDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [selectedCashier, setSelectedCashier] = useState<POSCashier | null>(null);
  const [isStandaloneCashier, setIsStandaloneCashier] = useState(false);

  // Add form state
  const [newCashier, setNewCashier] = useState({
    user_id: "",
    display_name: "",
    employee_number: "",
    can_void_transactions: false,
    can_apply_discounts: false,
    can_process_returns: false,
    can_open_cash_drawer: false,
    max_discount_percent: 0,
    max_void_amount: 0,
    register_ids: [] as string[],
  });

  // Edit form state
  const [editCashier, setEditCashier] = useState({
    display_name: "",
    employee_number: "",
    can_void_transactions: false,
    can_apply_discounts: false,
    can_process_returns: false,
    can_open_cash_drawer: false,
    max_discount_percent: 0,
    max_void_amount: 0,
    register_ids: [] as string[],
  });

  // PIN form state
  const [newPin, setNewPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");

  useEffect(() => {
    console.log(`[LIFECYCLE] CashierManagementCard MOUNTED (${id})`);
    return () => {
      console.log(`[LIFECYCLE] CashierManagementCard UNMOUNTING (${id})`);
    };
  }, [id]);

  const handleAddCashier = async () => {
    // For standalone cashiers, only display_name is required
    // For linked cashiers, both user_id and display_name are required
    if (!newCashier.display_name || (!isStandaloneCashier && !newCashier.user_id)) return;

    await createCashier.mutateAsync({
      ...newCashier,
      user_id: isStandaloneCashier ? undefined : newCashier.user_id,
      employee_number: newCashier.employee_number || undefined,
    });

    setShowAddDialog(false);
    setIsStandaloneCashier(false);
    setNewCashier({
      user_id: "",
      display_name: "",
      employee_number: "",
      can_void_transactions: false,
      can_apply_discounts: false,
      can_process_returns: false,
      can_open_cash_drawer: false,
      max_discount_percent: 0,
      max_void_amount: 0,
      register_ids: [],
    });
  };

  const handleEditCashier = async () => {
    if (!selectedCashier) return;

    await updateCashier.mutateAsync({
      id: selectedCashier.id,
      ...editCashier,
      employee_number: editCashier.employee_number || undefined,
    });

    setShowEditDialog(false);
    setSelectedCashier(null);
  };

  const handleSetPin = async () => {
    if (!selectedCashier || newPin.length < 4 || newPin !== confirmPin) return;

    await setCashierPin.mutateAsync({
      cashier_id: selectedCashier.id,
      pin: newPin,
    });

    setShowPinDialog(false);
    setSelectedCashier(null);
    setNewPin("");
    setConfirmPin("");
  };

  const handleDeleteCashier = async () => {
    if (!selectedCashier) return;

    await deleteCashier.mutateAsync(selectedCashier.id);
    setShowDeleteDialog(false);
    setSelectedCashier(null);
  };

  const openEditDialog = (cashier: POSCashier) => {
    setSelectedCashier(cashier);
    setEditCashier({
      display_name: cashier.display_name,
      employee_number: cashier.employee_number || "",
      can_void_transactions: cashier.can_void_transactions,
      can_apply_discounts: cashier.can_apply_discounts,
      can_process_returns: cashier.can_process_returns,
      can_open_cash_drawer: cashier.can_open_cash_drawer,
      max_discount_percent: cashier.max_discount_percent,
      max_void_amount: cashier.max_void_amount,
      register_ids: cashier.assigned_registers?.map(r => r.register_id) || [],
    });
    setShowEditDialog(true);
  };

  const handleUserSelect = (userId: string) => {
    const user = availableUsers.find(u => u.user_id === userId);
    setNewCashier(prev => ({
      ...prev,
      user_id: userId,
      display_name: user?.full_name || user?.email || "",
    }));
  };

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <UserCog className="h-5 w-5" />
                Cashier Management
              </CardTitle>
              <CardDescription>Manage cashiers, permissions, and register assignments</CardDescription>
            </div>
            <Button onClick={() => setShowAddDialog(true)} size="sm">
              <Plus className="h-4 w-4 mr-2" />
              Add Cashier
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoadingCashiers ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : cashiers.length === 0 ? (
            <div className="text-center py-8 px-4">
              <div className="mx-auto w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                <UserCog className="h-8 w-8 text-primary opacity-70" />
              </div>
              <h3 className="font-medium mb-2">No Cashiers Configured</h3>
              <p className="text-sm text-muted-foreground mb-4 max-w-sm mx-auto">
                Add cashiers to enable terminal login. You can link to team members or create standalone cashiers with just a name and PIN.
              </p>
              <Button onClick={() => setShowAddDialog(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Add Your First Cashier
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {cashiers.map((cashier) => {
                // Operator-visible scope cue mirroring POSSettings registers
                // tab. Server-side RLS + assert_pos_caller_branch_access
                // remain the authority — this is HQ-overseer UX.
                const cashierBranchId = (cashier as any).branch_id ?? null;
                const isForeignBranch =
                  !!currentBranch?.id && cashierBranchId !== currentBranch.id;
                const isOverseerReadOnly =
                  !currentBranch?.id && canOversee && !!cashierBranchId;
                const mutateLocked = isForeignBranch || isOverseerReadOnly;
                return (
                <div
                  key={cashier.id}
                  className={`flex flex-col sm:flex-row sm:items-center justify-between p-4 border rounded-lg gap-3 ${mutateLocked ? "opacity-90" : ""}`}
                >
                  <div className="flex items-start sm:items-center gap-3">
                    <div className={`p-2 rounded-lg ${cashier.is_active ? 'bg-green-100 dark:bg-green-900/30' : 'bg-muted'}`}>
                      <UserCog className={`h-5 w-5 ${cashier.is_active ? 'text-green-600' : 'text-muted-foreground'}`} />
                    </div>
                    <div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium">{cashier.display_name}</p>
                        {cashier.employee_number && (
                          <Badge variant="outline" className="text-xs">
                            #{cashier.employee_number}
                          </Badge>
                        )}
                        <Badge variant={cashier.is_active ? "default" : "secondary"} className="text-xs">
                          {cashier.is_active ? "Active" : "Disabled"}
                        </Badge>
                        <ScopeOwnershipBadge
                          ownerBranchId={cashierBranchId}
                          ownerBranchName={cashierBranchId ? branchNameById.get(cashierBranchId) ?? null : null}
                          activeBranchId={currentBranch?.id ?? null}
                        />
                      </div>
                      <p className="text-sm text-muted-foreground">{cashier.user_email}</p>
                      <div className="flex flex-wrap gap-1.5 mt-1">
                        {cashier.assigned_registers?.map((reg) => (
                          <Badge key={reg.id} variant="outline" className="text-xs">
                            <Monitor className="h-3 w-3 mr-1" />
                            {reg.register_name}
                            {reg.is_primary && " ★"}
                          </Badge>
                        ))}
                        {(!cashier.assigned_registers || cashier.assigned_registers.length === 0) && (
                          <span className="text-xs text-muted-foreground">No registers assigned</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 self-end sm:self-auto">
                    {/* Permission indicators */}
                    <div className="hidden md:flex items-center gap-1">
                      {cashier.can_void_transactions && (
                        <Badge variant="outline" className="text-xs" title="Can Void">V</Badge>
                      )}
                      {cashier.can_apply_discounts && (
                        <Badge variant="outline" className="text-xs" title="Can Discount">D</Badge>
                      )}
                      {cashier.can_process_returns && (
                        <Badge variant="outline" className="text-xs" title="Can Return">R</Badge>
                      )}
                    </div>

                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8">
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => openEditDialog(cashier)}>
                          <Pencil className="h-4 w-4 mr-2" />
                          Edit Cashier
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => {
                          setSelectedCashier(cashier);
                          setShowPinDialog(true);
                        }}>
                          <Key className="h-4 w-4 mr-2" />
                          Set PIN
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={() => toggleCashierStatus.mutate({
                            id: cashier.id,
                            is_active: !cashier.is_active,
                          })}
                        >
                          {cashier.is_active ? (
                            <>
                              <PowerOff className="h-4 w-4 mr-2" />
                              Disable Cashier
                            </>
                          ) : (
                            <>
                              <Power className="h-4 w-4 mr-2" />
                              Enable Cashier
                            </>
                          )}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-destructive"
                          onClick={() => {
                            setSelectedCashier(cashier);
                            setShowDeleteDialog(true);
                          }}
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          Remove Cashier
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add Cashier Dialog */}
      <Dialog open={showAddDialog} onOpenChange={(open) => {
        setShowAddDialog(open);
        if (!open) setIsStandaloneCashier(false);
      }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add New Cashier</DialogTitle>
            <DialogDescription>
              Create a new cashier account with terminal access
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4 max-h-[60vh] overflow-y-auto">
            {/* Standalone toggle */}
            <div className="flex items-center justify-between p-3 border rounded-lg bg-muted/50">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium">Standalone Cashier</Label>
                <p className="text-xs text-muted-foreground">
                  Create cashier without linking to a team member account
                </p>
              </div>
              <Switch
                checked={isStandaloneCashier}
                onCheckedChange={(checked) => {
                  setIsStandaloneCashier(checked);
                  if (checked) {
                    setNewCashier(prev => ({ ...prev, user_id: "" }));
                  }
                }}
              />
            </div>

            {!isStandaloneCashier && (
              <div className="space-y-2">
                <Label>Team Member</Label>
                <Select
                  value={newCashier.user_id}
                  onValueChange={handleUserSelect}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a team member" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableUsers.length === 0 ? (
                      <SelectItem value="_none" disabled>
                        No available team members
                      </SelectItem>
                    ) : (
                      availableUsers.map((user) => (
                        <SelectItem key={user.user_id} value={user.user_id}>
                          {user.full_name || user.email}
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
                {availableUsers.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No team members available. Enable "Standalone Cashier" to create without a linked account.
                  </p>
                )}
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Display Name</Label>
                <Input
                  placeholder="Cashier name"
                  value={newCashier.display_name}
                  onChange={(e) => setNewCashier(prev => ({ ...prev, display_name: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>Employee Number</Label>
                <Input
                  placeholder="Optional"
                  value={newCashier.employee_number}
                  onChange={(e) => setNewCashier(prev => ({ ...prev, employee_number: e.target.value }))}
                />
              </div>
            </div>

            <Separator />

            <div className="space-y-3">
              <Label className="text-sm font-medium">Permissions</Label>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="void"
                    checked={newCashier.can_void_transactions}
                    onCheckedChange={(checked) => setNewCashier(prev => ({ ...prev, can_void_transactions: !!checked }))}
                  />
                  <Label htmlFor="void" className="text-sm font-normal">Can void transactions</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="discount"
                    checked={newCashier.can_apply_discounts}
                    onCheckedChange={(checked) => setNewCashier(prev => ({ ...prev, can_apply_discounts: !!checked }))}
                  />
                  <Label htmlFor="discount" className="text-sm font-normal">Can apply discounts</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="returns"
                    checked={newCashier.can_process_returns}
                    onCheckedChange={(checked) => setNewCashier(prev => ({ ...prev, can_process_returns: !!checked }))}
                  />
                  <Label htmlFor="returns" className="text-sm font-normal">Can process returns</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="drawer"
                    checked={newCashier.can_open_cash_drawer}
                    onCheckedChange={(checked) => setNewCashier(prev => ({ ...prev, can_open_cash_drawer: !!checked }))}
                  />
                  <Label htmlFor="drawer" className="text-sm font-normal">Can open cash drawer</Label>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Max Discount %</Label>
                <Input
                  type="number"
                  min="0"
                  max="100"
                  value={newCashier.max_discount_percent}
                  onChange={(e) => setNewCashier(prev => ({ ...prev, max_discount_percent: parseFloat(e.target.value) || 0 }))}
                />
              </div>
              <div className="space-y-2">
                <Label>Max Void Amount</Label>
                <Input
                  type="number"
                  min="0"
                  value={newCashier.max_void_amount}
                  onChange={(e) => setNewCashier(prev => ({ ...prev, max_void_amount: parseFloat(e.target.value) || 0 }))}
                />
              </div>
            </div>

            <Separator />

            <div className="space-y-3">
              <Label className="text-sm font-medium">Assigned Registers</Label>
              <div className="grid grid-cols-2 gap-2">
                {registers.map((register) => (
                  <div key={register.id} className="flex items-center space-x-2">
                    <Checkbox
                      id={`reg-${register.id}`}
                      checked={newCashier.register_ids.includes(register.id)}
                      onCheckedChange={(checked) => {
                        setNewCashier(prev => ({
                          ...prev,
                          register_ids: checked
                            ? [...prev.register_ids, register.id]
                            : prev.register_ids.filter(id => id !== register.id),
                        }));
                      }}
                    />
                    <Label htmlFor={`reg-${register.id}`} className="text-sm font-normal">
                      {register.register_name}
                    </Label>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setShowAddDialog(false);
              setIsStandaloneCashier(false);
            }}>
              Cancel
            </Button>
            <Button
              onClick={handleAddCashier}
              disabled={!newCashier.display_name || (!isStandaloneCashier && !newCashier.user_id) || createCashier.isPending}
            >
              {createCashier.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Add Cashier
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Cashier Dialog */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Cashier</DialogTitle>
            <DialogDescription>
              Update cashier details and permissions
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4 max-h-[60vh] overflow-y-auto">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Display Name</Label>
                <Input
                  value={editCashier.display_name}
                  onChange={(e) => setEditCashier(prev => ({ ...prev, display_name: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>Employee Number</Label>
                <Input
                  value={editCashier.employee_number}
                  onChange={(e) => setEditCashier(prev => ({ ...prev, employee_number: e.target.value }))}
                />
              </div>
            </div>

            <Separator />

            <div className="space-y-3">
              <Label className="text-sm font-medium">Permissions</Label>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    checked={editCashier.can_void_transactions}
                    onCheckedChange={(checked) => setEditCashier(prev => ({ ...prev, can_void_transactions: !!checked }))}
                  />
                  <Label className="text-sm font-normal">Can void transactions</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    checked={editCashier.can_apply_discounts}
                    onCheckedChange={(checked) => setEditCashier(prev => ({ ...prev, can_apply_discounts: !!checked }))}
                  />
                  <Label className="text-sm font-normal">Can apply discounts</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    checked={editCashier.can_process_returns}
                    onCheckedChange={(checked) => setEditCashier(prev => ({ ...prev, can_process_returns: !!checked }))}
                  />
                  <Label className="text-sm font-normal">Can process returns</Label>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    checked={editCashier.can_open_cash_drawer}
                    onCheckedChange={(checked) => setEditCashier(prev => ({ ...prev, can_open_cash_drawer: !!checked }))}
                  />
                  <Label className="text-sm font-normal">Can open cash drawer</Label>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Max Discount %</Label>
                <Input
                  type="number"
                  min="0"
                  max="100"
                  value={editCashier.max_discount_percent}
                  onChange={(e) => setEditCashier(prev => ({ ...prev, max_discount_percent: parseFloat(e.target.value) || 0 }))}
                />
              </div>
              <div className="space-y-2">
                <Label>Max Void Amount</Label>
                <Input
                  type="number"
                  min="0"
                  value={editCashier.max_void_amount}
                  onChange={(e) => setEditCashier(prev => ({ ...prev, max_void_amount: parseFloat(e.target.value) || 0 }))}
                />
              </div>
            </div>

            <Separator />

            <div className="space-y-3">
              <Label className="text-sm font-medium">Assigned Registers</Label>
              <div className="grid grid-cols-2 gap-2">
                {registers.map((register) => (
                  <div key={register.id} className="flex items-center space-x-2">
                    <Checkbox
                      checked={editCashier.register_ids.includes(register.id)}
                      onCheckedChange={(checked) => {
                        setEditCashier(prev => ({
                          ...prev,
                          register_ids: checked
                            ? [...prev.register_ids, register.id]
                            : prev.register_ids.filter(id => id !== register.id),
                        }));
                      }}
                    />
                    <Label className="text-sm font-normal">{register.register_name}</Label>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleEditCashier}
              disabled={!editCashier.display_name || updateCashier.isPending}
            >
              {updateCashier.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Set PIN Dialog */}
      <Dialog open={showPinDialog} onOpenChange={setShowPinDialog}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Set Cashier PIN</DialogTitle>
            <DialogDescription>
              Set a 4-6 digit PIN for {selectedCashier?.display_name}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label>New PIN</Label>
              <Input
                type="password"
                maxLength={6}
                placeholder="Enter 4-6 digit PIN"
                value={newPin}
                onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ""))}
              />
            </div>
            <div className="space-y-2">
              <Label>Confirm PIN</Label>
              <Input
                type="password"
                maxLength={6}
                placeholder="Confirm PIN"
                value={confirmPin}
                onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ""))}
              />
            </div>
            {newPin && confirmPin && newPin !== confirmPin && (
              <p className="text-sm text-destructive">PINs do not match</p>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => {
              setShowPinDialog(false);
              setNewPin("");
              setConfirmPin("");
            }}>
              Cancel
            </Button>
            <Button
              onClick={handleSetPin}
              disabled={newPin.length < 4 || newPin !== confirmPin || setCashierPin.isPending}
            >
              {setCashierPin.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Set PIN
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Cashier</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove {selectedCashier?.display_name}? 
              This will end all active sessions and revoke their POS access.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleDeleteCashier}
            >
              {deleteCashier.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Remove Cashier
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
