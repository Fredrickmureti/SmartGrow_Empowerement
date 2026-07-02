import { useState } from "react";
import { useAnalyticAccounts, AnalyticAccount, AnalyticType, AnalyticGroup } from "@/hooks/useAnalyticAccounts";
import { useCurrency } from "@/hooks/useCurrency";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import {
  Plus,
  Search,
  Loader2,
  Target,
  Briefcase,
  Building2,
  Package,
  MoreHorizontal,
  Pencil,
  Trash2,
  FolderTree,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ConfirmDeleteDialog, useConfirmDelete } from "@/components/shared/ConfirmDeleteDialog";
import { normalizeError } from "@/services/resilience";

const ANALYTIC_TYPES: { value: AnalyticType; label: string; icon: React.ElementType }[] = [
  { value: "cost_center", label: "Cost Center", icon: Target },
  { value: "project", label: "Project", icon: Briefcase },
  { value: "department", label: "Department", icon: Building2 },
  { value: "product_line", label: "Product Line", icon: Package },
  { value: "other", label: "Other", icon: FolderTree },
];

export default function AnalyticAccounts() {
  const {
    groups,
    accounts,
    isLoading,
    createGroup,
    createAccount,
    updateAccount,
    deleteAccount,
  } = useAnalyticAccounts();
  const { formatCurrency } = useCurrency();
  const { toast } = useToast();

  const [showAccountDialog, setShowAccountDialog] = useState(false);
  const [showGroupDialog, setShowGroupDialog] = useState(false);
  const [editingAccount, setEditingAccount] = useState<AnalyticAccount | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [accountForm, setAccountForm] = useState({
    code: "",
    name: "",
    description: "",
    analytic_type: "cost_center" as AnalyticType,
    group_id: "",
  });

  const [groupForm, setGroupForm] = useState({
    name: "",
    description: "",
  });

  const resetAccountForm = () => {
    setAccountForm({
      code: "",
      name: "",
      description: "",
      analytic_type: "cost_center",
      group_id: "",
    });
    setEditingAccount(null);
  };

  const handleOpenAccountDialog = (account?: AnalyticAccount) => {
    if (account) {
      setEditingAccount(account);
      setAccountForm({
        code: account.code || "",
        name: account.name,
        description: account.description || "",
        analytic_type: account.analytic_type,
        group_id: account.group_id || "",
      });
    } else {
      resetAccountForm();
    }
    setShowAccountDialog(true);
  };

  const handleSubmitAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      if (editingAccount) {
        await updateAccount.mutateAsync({
          id: editingAccount.id,
          code: accountForm.code || null,
          name: accountForm.name,
          description: accountForm.description || null,
          analytic_type: accountForm.analytic_type,
          group_id: accountForm.group_id || null,
        });
        toast({ title: "Analytic account updated" });
      } else {
        await createAccount.mutateAsync({
          code: accountForm.code || undefined,
          name: accountForm.name,
          description: accountForm.description || undefined,
          analytic_type: accountForm.analytic_type,
          group_id: accountForm.group_id || undefined,
        });
        toast({ title: "Analytic account created" });
      }
      setShowAccountDialog(false);
      resetAccountForm();
    } catch (error: any) {
      toast({ title: "Error", description: normalizeError(error).message, variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSubmitGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    try {
      await createGroup.mutateAsync({
        name: groupForm.name,
        description: groupForm.description || undefined,
      });
      toast({ title: "Group created" });
      setShowGroupDialog(false);
      setGroupForm({ name: "", description: "" });
    } catch (error: any) {
      toast({ title: "Error", description: normalizeError(error).message, variant: "destructive" });
    } finally {
      setIsSubmitting(false);
    }
  };

  const executeDelete = async (account: AnalyticAccount) => {
    try {
      await deleteAccount.mutateAsync(account.id);
      toast({ title: "Account deleted" });
    } catch (error: any) {
      toast({ title: "Error", description: normalizeError(error).message, variant: "destructive" });
    }
  };

  const deleteConfirm = useConfirmDelete<AnalyticAccount>({ onConfirm: executeDelete });

  const filteredAccounts = accounts.filter((account) => {
    const matchesSearch =
      account.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      account.code?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesType = typeFilter === "all" || account.analytic_type === typeFilter;
    return matchesSearch && matchesType;
  });

  const getTypeIcon = (type: AnalyticType) => {
    const found = ANALYTIC_TYPES.find((t) => t.value === type);
    return found?.icon || FolderTree;
  };

  const getTypeBadge = (type: AnalyticType) => {
    const colors: Record<AnalyticType, string> = {
      cost_center: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
      project: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
      department: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
      product_line: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
      other: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200",
    };
    return (
      <Badge className={colors[type]}>
        {ANALYTIC_TYPES.find((t) => t.value === type)?.label || type}
      </Badge>
    );
  };

  const stats = {
    total: accounts.length,
    active: accounts.filter((a) => a.is_active).length,
    byType: ANALYTIC_TYPES.map((t) => ({
      ...t,
      count: accounts.filter((a) => a.analytic_type === t.value).length,
    })),
  };

  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header flex-col sm:flex-row gap-4">
          <div>
            <h1 className="page-title">Analytic Accounts</h1>
            <p className="text-sm sm:text-base text-muted-foreground">
              Track costs and revenues by cost center, project, or department
            </p>
          </div>
          <div className="flex flex-wrap gap-2 w-full sm:w-auto">
            <Button variant="outline" onClick={() => setShowGroupDialog(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Add Group
            </Button>
            <Button onClick={() => handleOpenAccountDialog()}>
              <Plus className="mr-2 h-4 w-4" />
              Add Account
            </Button>
          </div>
        </div>

        {/* Stats */}
        <div className="stats-grid grid-cols-2 sm:grid-cols-5">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total</CardTitle>
              <FolderTree className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{stats.total}</div>
            </CardContent>
          </Card>
          {stats.byType.slice(0, 4).map(({ value, label, icon: Icon, count }) => (
            <Card key={value}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{label}</CardTitle>
                <Icon className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{count}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Filters */}
        <div className="filter-bar">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search accounts..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 w-full"
            />
          </div>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-full sm:w-44">
              <SelectValue placeholder="All types" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              {ANALYTIC_TYPES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Table */}
        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : filteredAccounts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Target className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium">No analytic accounts</h3>
                <p className="text-muted-foreground">
                  Create cost centers, projects, or departments to track expenses.
                </p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Code</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Group</TableHead>
                    <TableHead className="text-right">Balance</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredAccounts.map((account) => {
                    const Icon = getTypeIcon(account.analytic_type);
                    return (
                      <TableRow key={account.id}>
                        <TableCell className="font-mono">{account.code || "—"}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Icon className="h-4 w-4 text-muted-foreground" />
                            <span className="font-medium">{account.name}</span>
                          </div>
                        </TableCell>
                        <TableCell>{getTypeBadge(account.analytic_type)}</TableCell>
                        <TableCell>{account.group?.name || "—"}</TableCell>
                        <TableCell className="text-right">
                          {formatCurrency(account.balance)}
                        </TableCell>
                        <TableCell>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => handleOpenAccountDialog(account)}>
                                <Pencil className="mr-2 h-4 w-4" />
                                Edit
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => deleteConfirm.requestDelete(account)}
                                className="text-destructive"
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Create/Edit Account Dialog */}
        <Dialog open={showAccountDialog} onOpenChange={setShowAccountDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {editingAccount ? "Edit Analytic Account" : "Create Analytic Account"}
              </DialogTitle>
              <DialogDescription>
                Track costs and revenues by cost center, project, or department.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmitAccount} className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="code">Code</Label>
                  <Input
                    id="code"
                    value={accountForm.code}
                    onChange={(e) => setAccountForm({ ...accountForm, code: e.target.value })}
                    placeholder="e.g., CC-001"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="analytic_type">Type *</Label>
                  <Select
                    value={accountForm.analytic_type}
                    onValueChange={(v) => setAccountForm({ ...accountForm, analytic_type: v as AnalyticType })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ANALYTIC_TYPES.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="name">Name *</Label>
                <Input
                  id="name"
                  value={accountForm.name}
                  onChange={(e) => setAccountForm({ ...accountForm, name: e.target.value })}
                  placeholder="e.g., Marketing Department"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="group_id">Group</Label>
                <Select
                  value={accountForm.group_id}
                  onValueChange={(v) => setAccountForm({ ...accountForm, group_id: v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select group (optional)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">No group</SelectItem>
                    {groups.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={accountForm.description}
                  onChange={(e) => setAccountForm({ ...accountForm, description: e.target.value })}
                  rows={2}
                />
              </div>
              <div className="flex justify-end gap-3">
                <Button type="button" variant="outline" onClick={() => setShowAccountDialog(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {editingAccount ? "Update" : "Create"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>

        {/* Create Group Dialog */}
        <Dialog open={showGroupDialog} onOpenChange={setShowGroupDialog}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create Analytic Group</DialogTitle>
              <DialogDescription>
                Group related analytic accounts together.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmitGroup} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="group_name">Name *</Label>
                <Input
                  id="group_name"
                  value={groupForm.name}
                  onChange={(e) => setGroupForm({ ...groupForm, name: e.target.value })}
                  placeholder="e.g., Regional Cost Centers"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="group_description">Description</Label>
                <Textarea
                  id="group_description"
                  value={groupForm.description}
                  onChange={(e) => setGroupForm({ ...groupForm, description: e.target.value })}
                  rows={2}
                />
              </div>
              <div className="flex justify-end gap-3">
                <Button type="button" variant="outline" onClick={() => setShowGroupDialog(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Create
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>

        <ConfirmDeleteDialog
          open={deleteConfirm.isOpen}
          onOpenChange={deleteConfirm.setIsOpen}
          onConfirm={deleteConfirm.confirmDelete}
          title="Delete Analytic Account"
          itemName={deleteConfirm.itemToDelete?.name}
          isLoading={deleteConfirm.isDeleting}
        />
      </div>
    </>
  );
}
