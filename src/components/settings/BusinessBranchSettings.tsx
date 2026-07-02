import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { useBusinesses, Business, CreateBusinessInput } from "@/hooks/useBusinesses";
import { useBranches, Branch } from "@/hooks/useBranches";
import { CreateBusinessDialog } from "@/components/organization/CreateBusinessDialog";
import { CreateBranchDialog } from "@/components/organization/CreateBranchDialog";
import { usePermissions } from "@/hooks/usePermissions";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Building2,
  MapPin,
  Plus,
  MoreHorizontal,
  Pencil,
  Trash2,
  Loader2,
  Star,
  ChevronDown,
  ChevronRight,
  Eye,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { useCountries } from "@/hooks/useCountries";
import { Settings as SettingsIcon } from "lucide-react";
import { BusinessLogoUpload } from "@/components/settings/BusinessLogoUpload";
import { BranchOperations } from "@/components/settings/BranchOperations";
import { BranchConfiguration } from "@/components/settings/BranchConfiguration";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function BusinessBranchSettings() {
  const { businesses, isLoading: isLoadingBusinesses, updateBusiness, deleteBusiness } = useBusinesses();
  const { canManageBusiness } = usePermissions();
  const { countries } = useCountries();
  const [showCreateBusinessDialog, setShowCreateBusinessDialog] = useState(false);
  const [showCreateBranchDialog, setShowCreateBranchDialog] = useState(false);
  const [selectedBusinessId, setSelectedBusinessId] = useState<string | null>(null);
  const [expandedBusinessId, setExpandedBusinessId] = useState<string | null>(null);
  const [editingBusiness, setEditingBusiness] = useState<Business | null>(null);
  const [deleteConfirmBusiness, setDeleteConfirmBusiness] = useState<Business | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleAddBranch = (businessId: string) => {
    setSelectedBusinessId(businessId);
    setShowCreateBranchDialog(true);
  };

  const handleEditBusiness = (business: Business) => {
    setEditingBusiness(business);
  };

  const handleDeleteBusiness = async () => {
    if (!deleteConfirmBusiness) return;
    setIsDeleting(true);
    try {
      await deleteBusiness(deleteConfirmBusiness.id);
      setDeleteConfirmBusiness(null);
    } catch (error) {
      console.error("Error deleting business:", error);
    } finally {
      setIsDeleting(false);
    }
  };

  const toggleExpand = (businessId: string) => {
    setExpandedBusinessId(expandedBusinessId === businessId ? null : businessId);
  };

  if (isLoadingBusinesses) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {!canManageBusiness && (
        <Alert>
          <Eye className="h-4 w-4" />
          <AlertDescription>
            You have view-only access to businesses and branches. Contact an admin to make changes.
          </AlertDescription>
        </Alert>
      )}
      
      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Building2 className="h-5 w-5" />
                Businesses
              </CardTitle>
              <CardDescription>
                Manage separate business entities within your organization
              </CardDescription>
            </div>
            {canManageBusiness && (
              <Button onClick={() => setShowCreateBusinessDialog(true)} className="w-full sm:w-auto">
                <Plus className="mr-2 h-4 w-4" />
                Add Business
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {businesses.length === 0 ? (
            <div className="text-center py-12">
              <Building2 className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">No businesses yet</h3>
              <p className="text-muted-foreground mb-4">
                {canManageBusiness 
                  ? "Create your first business to manage multiple entities"
                  : "No businesses have been created yet"}
              </p>
              {canManageBusiness && (
                <Button onClick={() => setShowCreateBusinessDialog(true)}>
                  <Plus className="mr-2 h-4 w-4" />
                  Create Business
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {businesses.map((business) => (
                <BusinessCard
                  key={business.id}
                  business={business}
                  isExpanded={expandedBusinessId === business.id}
                  onToggleExpand={() => toggleExpand(business.id)}
                  onEdit={() => handleEditBusiness(business)}
                  onDelete={() => setDeleteConfirmBusiness(business)}
                  onAddBranch={() => handleAddBranch(business.id)}
                  canManage={canManageBusiness}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <CreateBusinessDialog
        open={showCreateBusinessDialog}
        onOpenChange={setShowCreateBusinessDialog}
      />

      {selectedBusinessId && (
        <CreateBranchDialog
          open={showCreateBranchDialog}
          onOpenChange={setShowCreateBranchDialog}
          businessId={selectedBusinessId}
        />
      )}

      <EditBusinessDialog
        business={editingBusiness}
        onClose={() => setEditingBusiness(null)}
        onSave={updateBusiness}
      />

      <Dialog open={!!deleteConfirmBusiness} onOpenChange={() => setDeleteConfirmBusiness(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Business</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{deleteConfirmBusiness?.name}"? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmBusiness(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeleteBusiness} disabled={isDeleting}>
              {isDeleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface BusinessCardProps {
  business: Business;
  isExpanded: boolean;
  onToggleExpand: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onAddBranch: () => void;
  canManage: boolean;
}

function BusinessCard({
  business,
  isExpanded,
  onToggleExpand,
  onEdit,
  onDelete,
  onAddBranch,
  canManage,
}: BusinessCardProps) {
  const { branches, isLoading: isLoadingBranches, deleteBranch, setHeadquarters } = useBranches();
  const [deleteConfirmBranch, setDeleteConfirmBranch] = useState<Branch | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [settingsBranch, setSettingsBranch] = useState<Branch | null>(null);

  const handleDeleteBranch = async () => {
    if (!deleteConfirmBranch) return;
    setIsDeleting(true);
    try {
      await deleteBranch(deleteConfirmBranch.id);
      setDeleteConfirmBranch(null);
    } catch (error) {
      console.error("Error deleting branch:", error);
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="border rounded-lg">
      <div
        className="flex items-center justify-between p-3 sm:p-4 cursor-pointer hover:bg-muted/50 transition-colors gap-2"
        onClick={onToggleExpand}
      >
        <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
          <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}>
            {isExpanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </Button>
          <Building2 className="h-5 w-5 text-muted-foreground shrink-0 hidden sm:block" />
          <div className="min-w-0">
            <h4 className="font-medium truncate">{business.name}</h4>
            <p className="text-sm text-muted-foreground truncate">
              {business.legal_name || business.email || "No additional info"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge variant="secondary">{branches.length} branches</Badge>
          {canManage && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                <Button variant="ghost" size="icon" className="h-8 w-8">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onEdit(); }}>
                  <Pencil className="mr-2 h-4 w-4" />
                  Edit
                </DropdownMenuItem>
                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onAddBranch(); }}>
                  <MapPin className="mr-2 h-4 w-4" />
                  Add Branch
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={(e) => { e.stopPropagation(); onDelete(); }}
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {isExpanded && (
        <div className="border-t bg-muted/30 p-4">
          <div className="flex items-center justify-between mb-3">
            <h5 className="text-sm font-medium flex items-center gap-2">
              <MapPin className="h-4 w-4" />
              Branches
            </h5>
            {canManage && (
              <Button size="sm" variant="outline" onClick={onAddBranch}>
                <Plus className="mr-1 h-3 w-3" />
                Add Branch
              </Button>
            )}
          </div>

          {isLoadingBranches ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : branches.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No branches yet. Add your first branch.
            </p>
          ) : (
            <div className="overflow-x-auto -mx-4 px-4">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead className="hidden sm:table-cell">Code</TableHead>
                    <TableHead>Location</TableHead>
                    <TableHead className="hidden md:table-cell">Contact</TableHead>
                    <TableHead className="w-[100px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {branches.map((branch) => (
                    <TableRow key={branch.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className="truncate max-w-[120px] sm:max-w-none">{branch.name}</span>
                          {branch.is_headquarters && (
                            <Badge variant="default" className="text-xs whitespace-nowrap">
                              <Star className="mr-1 h-3 w-3" />
                              HQ
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">{branch.code || "-"}</TableCell>
                      <TableCell className="truncate max-w-[100px] sm:max-w-none">
                        {[branch.city, branch.state, branch.country].filter(Boolean).join(", ") || "-"}
                      </TableCell>
                      <TableCell className="hidden md:table-cell">{branch.phone || branch.email || "-"}</TableCell>
                      <TableCell>
                        {canManage && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              {!branch.is_headquarters && (
                                <DropdownMenuItem onClick={() => setHeadquarters(branch.id)}>
                                  <Star className="mr-2 h-4 w-4" />
                                  Set as Headquarters
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem onClick={() => setSettingsBranch(branch)}>
                                <SettingsIcon className="mr-2 h-4 w-4" />
                                Branch settings
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                className="text-destructive"
                                onClick={() => setDeleteConfirmBranch(branch)}
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}

      <Dialog open={!!deleteConfirmBranch} onOpenChange={() => setDeleteConfirmBranch(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Branch</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete "{deleteConfirmBranch?.name}"? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmBranch(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeleteBranch} disabled={isDeleting}>
              {isDeleting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!settingsBranch} onOpenChange={() => setSettingsBranch(null)}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Branch settings — {settingsBranch?.name}</DialogTitle>
            <DialogDescription>
              Configure branch overrides separately from operational scoping.
            </DialogDescription>
          </DialogHeader>
          {settingsBranch && (
            <Tabs defaultValue="configuration" className="space-y-4">
              <TabsList>
                <TabsTrigger value="configuration">Configuration</TabsTrigger>
                <TabsTrigger value="operations">Operational scoping</TabsTrigger>
              </TabsList>
              <TabsContent value="configuration">
                <BranchConfiguration branchId={settingsBranch.id} branchName={settingsBranch.name} business={business} />
              </TabsContent>
              <TabsContent value="operations">
                <BranchOperations branchId={settingsBranch.id} branchName={settingsBranch.name} businessId={business.id} />
              </TabsContent>
            </Tabs>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface EditBusinessDialogProps {
  business: Business | null;
  onClose: () => void;
  onSave: (id: string, updates: Partial<CreateBusinessInput>) => Promise<any>;
}

function EditBusinessDialog({ business, onClose, onSave }: EditBusinessDialogProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState<Partial<CreateBusinessInput>>({});
  const { countries } = useCountries();

  // Update form data when business changes
  useEffect(() => {
    if (business) {
      setFormData({
        name: business.name,
        legal_name: business.legal_name || "",
        tax_id: business.tax_id || "",
        registration_number: business.registration_number || "",
        email: business.email || "",
        phone: business.phone || "",
        website: business.website || "",
        address: business.address || "",
        city: business.city || "",
        state: business.state || "",
        postal_code: business.postal_code || "",
        country: business.country || "",
        invoice_prefix: business.invoice_prefix || "",
        estimate_prefix: business.estimate_prefix || "",
        bill_prefix: business.bill_prefix || "",
      });
    }
  }, [business]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!business) return;

    setIsLoading(true);
    try {
      await onSave(business.id, formData);
      onClose();
    } catch (error) {
      console.error("Error updating business:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const updateField = (field: keyof CreateBusinessInput, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  if (!business) return null;

  return (
    <Dialog open={!!business} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Business</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Per-company logo (Odoo res.company model). Lives at the top of the
              identity panel so accountants set it alongside legal name & tax id. */}
          <div className="rounded-lg border bg-muted/20 p-4">
            <BusinessLogoUpload
              organizationId={business.organization_id}
              businessId={business.id}
              currentLogoUrl={business.logo_url}
            />
          </div>

           <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Business Name</Label>
              <Input
                value={formData.name || business.name}
                onChange={(e) => updateField("name", e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Legal Name</Label>
              <Input
                value={formData.legal_name || business.legal_name || ""}
                onChange={(e) => updateField("legal_name", e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Tax ID</Label>
              <Input
                value={formData.tax_id || business.tax_id || ""}
                onChange={(e) => updateField("tax_id", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Registration Number</Label>
              <Input
                value={formData.registration_number || business.registration_number || ""}
                onChange={(e) => updateField("registration_number", e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>Email</Label>
              <Input
                type="email"
                value={formData.email || business.email || ""}
                onChange={(e) => updateField("email", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Phone</Label>
              <Input
                value={formData.phone || business.phone || ""}
                onChange={(e) => updateField("phone", e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Address</Label>
            <Textarea
              value={formData.address || business.address || ""}
              onChange={(e) => updateField("address", e.target.value)}
              rows={2}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>City</Label>
              <Input
                value={formData.city || business.city || ""}
                onChange={(e) => updateField("city", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>State/Province</Label>
              <Input
                value={formData.state || business.state || ""}
                onChange={(e) => updateField("state", e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Country</Label>
              <Select
                value={formData.country || business.country || ""}
                onValueChange={(value) => updateField("country", value)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select country" />
                </SelectTrigger>
                <SelectContent>
                  {countries.map((country) => (
                    <SelectItem key={country.code} value={country.code}>
                      {country.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Invoice Prefix</Label>
              <Input
                value={formData.invoice_prefix || business.invoice_prefix || ""}
                onChange={(e) => updateField("invoice_prefix", e.target.value)}
                placeholder="INV"
              />
            </div>
            <div className="space-y-2">
              <Label>Estimate Prefix</Label>
              <Input
                value={formData.estimate_prefix || business.estimate_prefix || ""}
                onChange={(e) => updateField("estimate_prefix", e.target.value)}
                placeholder="EST"
              />
            </div>
            <div className="space-y-2">
              <Label>Bill Prefix</Label>
              <Input
                value={formData.bill_prefix || business.bill_prefix || ""}
                onChange={(e) => updateField("bill_prefix", e.target.value)}
                placeholder="BILL"
              />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
