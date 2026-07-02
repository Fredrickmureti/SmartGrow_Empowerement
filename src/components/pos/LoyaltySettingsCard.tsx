import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { usePOSLoyalty, LoyaltyTier, LoyaltyProgramInput } from "@/hooks/pos/usePOSLoyalty";
import { useCurrency } from "@/hooks/useCurrency";
import { 
  Gift, 
  Star, 
  Award,
  Loader2,
  Plus,
  Pencil,
  Trash2,
  X,
  Check,
} from "lucide-react";

interface TierFormData {
  name: string;
  min_points: string;
  discount_percent: string;
}

export function LoyaltySettingsCard() {
  const { 
    allPrograms, 
    allProgramsLoading,
    createProgram,
    updateProgram,
    deleteProgram,
    toggleProgram,
    isCreating,
    isUpdating,
    isDeleting,
  } = usePOSLoyalty();
  const { getCurrencySymbol } = useCurrency();

  const [showProgramDialog, setShowProgramDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [editingProgram, setEditingProgram] = useState<typeof allPrograms[0] | null>(null);
  const [deletingProgramId, setDeletingProgramId] = useState<string | null>(null);

  // Program form state
  const [programName, setProgramName] = useState("");
  const [pointsPerCurrency, setPointsPerCurrency] = useState("1");
  const [pointsToCurrencyRatio, setPointsToCurrencyRatio] = useState("0.01");
  const [minimumRedemption, setMinimumRedemption] = useState("100");
  const [tiers, setTiers] = useState<LoyaltyTier[]>([]);
  const [newTier, setNewTier] = useState<TierFormData>({ name: "", min_points: "", discount_percent: "" });

  const resetForm = () => {
    setProgramName("");
    setPointsPerCurrency("1");
    setPointsToCurrencyRatio("0.01");
    setMinimumRedemption("100");
    setTiers([]);
    setNewTier({ name: "", min_points: "", discount_percent: "" });
    setEditingProgram(null);
  };

  const openCreateDialog = () => {
    resetForm();
    setShowProgramDialog(true);
  };

  const openEditDialog = (program: typeof allPrograms[0]) => {
    setEditingProgram(program);
    setProgramName(program.name);
    setPointsPerCurrency(String(program.points_per_currency));
    setPointsToCurrencyRatio(String(program.points_to_currency_ratio));
    setMinimumRedemption(String(program.minimum_points_redemption));
    setTiers(program.tiers || []);
    setShowProgramDialog(true);
  };

  const handleAddTier = () => {
    if (!newTier.name || !newTier.min_points || !newTier.discount_percent) return;
    
    setTiers([...tiers, {
      name: newTier.name,
      min_points: Number(newTier.min_points),
      discount_percent: Number(newTier.discount_percent),
    }].sort((a, b) => a.min_points - b.min_points));
    
    setNewTier({ name: "", min_points: "", discount_percent: "" });
  };

  const handleRemoveTier = (index: number) => {
    setTiers(tiers.filter((_, i) => i !== index));
  };

  const handleSubmit = async () => {
    const input: LoyaltyProgramInput = {
      name: programName,
      points_per_currency: Number(pointsPerCurrency),
      points_to_currency_ratio: Number(pointsToCurrencyRatio),
      minimum_points_redemption: Number(minimumRedemption),
      tiers,
      is_active: editingProgram?.is_active ?? true,
    };

    try {
      if (editingProgram) {
        await updateProgram({ id: editingProgram.id, ...input });
      } else {
        await createProgram(input);
      }
      setShowProgramDialog(false);
      resetForm();
    } catch (error) {
      // Error handled by mutation
    }
  };

  const handleDelete = async () => {
    if (!deletingProgramId) return;
    try {
      await deleteProgram(deletingProgramId);
      setShowDeleteDialog(false);
      setDeletingProgramId(null);
    } catch (error) {
      // Error handled by mutation
    }
  };

  const handleToggleActive = async (programId: string, currentActive: boolean) => {
    await toggleProgram({ id: programId, is_active: !currentActive });
  };

  if (allProgramsLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Programs List */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Gift className="h-5 w-5" />
              Loyalty Programs
            </CardTitle>
            <CardDescription>Configure points-based rewards for customers</CardDescription>
          </div>
          <Button onClick={openCreateDialog}>
            <Plus className="h-4 w-4 mr-2" />
            Create Program
          </Button>
        </CardHeader>
        <CardContent>
          {(!allPrograms || allPrograms.length === 0) ? (
            <div className="text-center py-8 text-muted-foreground">
              <Gift className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No loyalty programs configured</p>
              <p className="text-sm">Create a program to start rewarding your customers</p>
            </div>
          ) : (
            <div className="space-y-4">
              {allPrograms.map((prog) => (
                <div key={prog.id} className="flex items-center justify-between p-4 border rounded-lg">
                  <div className="flex items-center gap-4">
                    <div className={`p-3 rounded-lg ${prog.is_active ? 'bg-primary/10' : 'bg-muted'}`}>
                      <Star className={`h-5 w-5 ${prog.is_active ? 'text-primary' : 'text-muted-foreground'}`} />
                    </div>
                    <div>
                      <h3 className="font-medium flex items-center gap-2">
                        {prog.name}
                        {prog.is_active && <Badge variant="default" className="text-xs">Active</Badge>}
                      </h3>
                      <div className="text-sm text-muted-foreground space-x-4">
                        <span>{prog.points_per_currency} pts/{getCurrencySymbol()}1</span>
                        <span>•</span>
                        <span>{getCurrencySymbol()}{prog.points_to_currency_ratio}/pt value</span>
                        <span>•</span>
                        <span>Min: {prog.minimum_points_redemption} pts</span>
                        {prog.tiers.length > 0 && (
                          <>
                            <span>•</span>
                            <span>{prog.tiers.length} tier(s)</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={prog.is_active}
                      onCheckedChange={() => handleToggleActive(prog.id, prog.is_active)}
                    />
                    <Button variant="ghost" size="icon" onClick={() => openEditDialog(prog)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button 
                      variant="ghost" 
                      size="icon" 
                      className="text-destructive hover:text-destructive"
                      onClick={() => {
                        setDeletingProgramId(prog.id);
                        setShowDeleteDialog(true);
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

      {/* How It Works */}
      <Card>
        <CardHeader>
          <CardTitle>How Loyalty Works</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="flex gap-3">
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold">1</div>
              <div>
                <p className="font-medium">Customer makes a purchase</p>
                <p className="text-sm text-muted-foreground">Points are automatically calculated based on the transaction total</p>
              </div>
            </div>
            <div className="flex gap-3">
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold">2</div>
              <div>
                <p className="font-medium">Points accumulate</p>
                <p className="text-sm text-muted-foreground">Customers can view their balance and tier status</p>
              </div>
            </div>
            <div className="flex gap-3">
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary font-bold">3</div>
              <div>
                <p className="font-medium">Redeem for discounts</p>
                <p className="text-sm text-muted-foreground">Points can be redeemed at checkout for instant discounts</p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Create/Edit Program Dialog */}
      <Dialog open={showProgramDialog} onOpenChange={setShowProgramDialog}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingProgram ? "Edit" : "Create"} Loyalty Program</DialogTitle>
            <DialogDescription>
              Configure how customers earn and redeem points
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Program Name</Label>
              <Input
                id="name"
                placeholder="e.g., VIP Rewards"
                value={programName}
                onChange={(e) => setProgramName(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="points">Points per {getCurrencySymbol()}1</Label>
                <Input
                  id="points"
                  type="number"
                  min="0.01"
                  step="0.01"
                  placeholder="1"
                  value={pointsPerCurrency}
                  onChange={(e) => setPointsPerCurrency(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  How many points earned per currency unit spent
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="value">Point Value ({getCurrencySymbol()})</Label>
                <Input
                  id="value"
                  type="number"
                  min="0.001"
                  step="0.001"
                  placeholder="0.01"
                  value={pointsToCurrencyRatio}
                  onChange={(e) => setPointsToCurrencyRatio(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Cash value of each point when redeemed
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="minimum">Minimum Points to Redeem</Label>
              <Input
                id="minimum"
                type="number"
                min="1"
                placeholder="100"
                value={minimumRedemption}
                onChange={(e) => setMinimumRedemption(e.target.value)}
              />
            </div>

            {/* Tiers Section */}
            <div className="space-y-3 pt-2 border-t">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-2">
                  <Award className="h-4 w-4" />
                  Loyalty Tiers (Optional)
                </Label>
              </div>

              {tiers.length > 0 && (
                <div className="space-y-2">
                  {tiers.map((tier, index) => (
                    <div key={index} className="flex items-center gap-2 p-2 bg-muted rounded-md">
                      <span className="flex-1 font-medium">{tier.name}</span>
                      <Badge variant="secondary">{tier.min_points}+ pts</Badge>
                      <Badge variant="outline">{tier.discount_percent}% off</Badge>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        onClick={() => handleRemoveTier(index)}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex gap-2">
                <Input
                  placeholder="Tier name"
                  value={newTier.name}
                  onChange={(e) => setNewTier({ ...newTier, name: e.target.value })}
                  className="flex-1"
                />
                <Input
                  type="number"
                  placeholder="Min pts"
                  value={newTier.min_points}
                  onChange={(e) => setNewTier({ ...newTier, min_points: e.target.value })}
                  className="w-24"
                />
                <Input
                  type="number"
                  placeholder="% off"
                  value={newTier.discount_percent}
                  onChange={(e) => setNewTier({ ...newTier, discount_percent: e.target.value })}
                  className="w-20"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleAddTier}
                  disabled={!newTier.name || !newTier.min_points || !newTier.discount_percent}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Tiers give automatic discounts to customers who reach point thresholds
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowProgramDialog(false)}>
              Cancel
            </Button>
            <Button 
              onClick={handleSubmit}
              disabled={!programName || isCreating || isUpdating}
            >
              {(isCreating || isUpdating) && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {editingProgram ? "Save Changes" : "Create Program"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Loyalty Program?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this loyalty program. Customer loyalty data will be preserved but they won't be able to earn or redeem points until a new program is created.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={isDeleting}
            >
              {isDeleting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
