import { useState } from "react";
import { PlatformAppLayout } from "@/apps/platform";
import { useAuditLogsPaginated, AuditLogFilters } from "@/hooks/useAuditLogsPaginated";
import { useDebouncedCallback } from "@/hooks/useDebouncedCallback";
import { useOrganization } from "@/hooks/useOrganization";
import { useOrgMembers } from "@/hooks/useOrgMembers";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Search,
  History,
  Loader2,
  Eye,
  Download,
  Filter,
  Plus,
  Pencil,
  Trash2,
  RefreshCw,
} from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { DataTablePagination } from "@/components/common/DataTablePagination";
import { normalizeError } from "@/services/resilience";

interface AuditLogDetail {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  entity_name: string | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  changes_summary: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

export default function AuditLogs() {
  const [filters, setFilters] = useState<AuditLogFilters>({});
  const [searchInput, setSearchInput] = useState("");
  const [isClearing, setIsClearing] = useState(false);
  const { currentOrg } = useOrganization();
  const { getUserName, members } = useOrgMembers();
  
  // Check if user is admin or owner
  const userRole = currentOrg?.role;
  const isAdmin = userRole === "owner" || userRole === "admin" || userRole === "super_admin";
  
  // Debounced search
  const debouncedSearch = useDebouncedCallback((value: string) => {
    setFilters(prev => ({ ...prev, search: value || undefined }));
  }, 300);

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchInput(e.target.value);
    debouncedSearch(e.target.value);
  };

  const {
    auditLogs,
    entityTypes,
    actions,
    isLoading,
    isFetching,
    pagination,
    setPage,
    setPageSize,
    refetch,
  } = useAuditLogsPaginated(filters);
  
  const [selectedLog, setSelectedLog] = useState<AuditLogDetail | null>(null);
  const [showFilters, setShowFilters] = useState(false);

  const handleClearAllLogs = async () => {
    if (!currentOrg?.id) return;
    
    setIsClearing(true);
    try {
      const { data, error } = await supabase
        // SCOPE-EXEMPT: workspace-wide audit log clear by admin
        .from("audit_logs")
        .delete()
        .eq("organization_id", currentOrg.id)
        .select();

      if (error) throw error;

      // Check if any rows were actually deleted
      if (!data || data.length === 0) {
        throw new Error("Deletion was blocked by security policy. You may not have admin permissions.");
      }

      toast.success(`Cleared ${data.length} audit log entries`);
      refetch();
    } catch (error: any) {
      console.error("Error clearing audit logs:", error);
      toast.error(normalizeError(error).message || "Failed to clear audit logs");
    } finally {
      setIsClearing(false);
    }
  };

  const handleExportCSV = () => {
    const headers = ["Date", "User", "Action", "Entity Type", "Entity Name", "Changes"];
    const rows = auditLogs.map(log => [
      format(new Date(log.created_at), "yyyy-MM-dd HH:mm:ss"),
      getUserName(log.user_id),
      log.action,
      log.entity_type,
      log.entity_name || "",
      log.changes_summary || "",
    ]);
    
    const csv = [headers, ...rows].map(row => row.map(cell => `"${cell}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-logs-${format(new Date(), "yyyy-MM-dd")}.csv`;
    a.click();
  };

  const getActionIcon = (action: string) => {
    switch (action.toLowerCase()) {
      case "create": return <Plus className="h-3 w-3" />;
      case "update": return <Pencil className="h-3 w-3" />;
      case "delete": return <Trash2 className="h-3 w-3" />;
      default: return <RefreshCw className="h-3 w-3" />;
    }
  };

  const getActionBadge = (action: string) => {
    switch (action.toLowerCase()) {
      case "create": return <Badge className="bg-green-100 text-green-800">{getActionIcon(action)} Create</Badge>;
      case "update": return <Badge className="bg-blue-100 text-blue-800">{getActionIcon(action)} Update</Badge>;
      case "delete": return <Badge variant="destructive">{getActionIcon(action)} Delete</Badge>;
      default: return <Badge variant="outline">{action}</Badge>;
    }
  };

  return (
    <PlatformAppLayout>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div>
            <h1 className="page-title">Audit Logs</h1>
            <p className="text-sm sm:text-base text-muted-foreground">
              Track all changes made in your organization
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setShowFilters(!showFilters)}>
              <Filter className="mr-2 h-4 w-4" />
              Filters
            </Button>
            <Button variant="outline" onClick={handleExportCSV}>
              <Download className="mr-2 h-4 w-4" />
              Export CSV
            </Button>
            {isAdmin && auditLogs.length > 0 && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button 
                    variant="destructive" 
                    disabled={isClearing}
                  >
                    {isClearing ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="mr-2 h-4 w-4" />
                    )}
                    Clear All
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Clear All Audit Logs</AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently delete all audit logs for this organization. 
                      This action cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleClearAllLogs}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      Clear All Logs
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
          </div>
        </div>

        {/* Filters Panel */}
        {showFilters && (
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Filters</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 md:grid-cols-5">
                <div className="space-y-2">
                  <Label>User</Label>
                  <Select
                    value={filters.userId || "all"}
                    onValueChange={(v) => setFilters(prev => ({ ...prev, userId: v === "all" ? undefined : v }))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="All users" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Users</SelectItem>
                      {members.map(m => (
                        <SelectItem key={m.user_id} value={m.user_id}>
                          {m.full_name || m.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Entity Type</Label>
                  <Select
                    value={filters.entityType || "all"}
                    onValueChange={(v) => setFilters(prev => ({ ...prev, entityType: v === "all" ? undefined : v }))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="All types" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Types</SelectItem>
                      {entityTypes.map((type: any) => (
                        <SelectItem key={String(type)} value={String(type)}>{String(type)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Action</Label>
                  <Select
                    value={filters.action || "all"}
                    onValueChange={(v) => setFilters(prev => ({ ...prev, action: v === "all" ? undefined : v }))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="All actions" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Actions</SelectItem>
                      {actions.map((action: any) => (
                        <SelectItem key={String(action)} value={String(action)}>{String(action)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Start Date</Label>
                  <Input
                    type="date"
                    value={filters.startDate || ""}
                    onChange={(e) => setFilters(prev => ({ ...prev, startDate: e.target.value || undefined }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label>End Date</Label>
                  <Input
                    type="date"
                    value={filters.endDate || ""}
                    onChange={(e) => setFilters(prev => ({ ...prev, endDate: e.target.value || undefined }))}
                  />
                </div>
              </div>
              <div className="flex justify-end mt-4">
                <Button 
                  variant="ghost" 
                  onClick={() => {
                    setFilters({});
                    setSearchInput("");
                  }}
                >
                  Clear Filters
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Search */}
        <div className="flex gap-2">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search logs..."
              value={searchInput}
              onChange={handleSearchChange}
              className="pl-10"
            />
          </div>
        </div>

        {/* Table */}
        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : auditLogs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <History className="h-12 w-12 text-muted-foreground mb-4" />
                <h3 className="text-lg font-medium">No audit logs found</h3>
                <p className="text-muted-foreground">Changes will be recorded here</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date & Time</TableHead>
                    <TableHead>User</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Entity</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead className="max-w-xs">Changes</TableHead>
                    <TableHead className="w-12"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {auditLogs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell className="whitespace-nowrap">
                        {format(new Date(log.created_at), "MMM d, yyyy HH:mm")}
                      </TableCell>
                      <TableCell className="text-sm">
                        {getUserName(log.user_id)}
                      </TableCell>
                      <TableCell>{getActionBadge(log.action)}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{log.entity_type}</Badge>
                      </TableCell>
                      <TableCell className="font-medium">
                        {log.entity_name || "-"}
                      </TableCell>
                      <TableCell className="max-w-xs truncate text-muted-foreground">
                        {log.changes_summary || "-"}
                      </TableCell>
                      <TableCell>
                        <Button 
                          variant="ghost" 
                          size="icon"
                          onClick={() => setSelectedLog(log)}
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Pagination */}
        {auditLogs.length > 0 && (
          <DataTablePagination
            pagination={pagination}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
            isLoading={isFetching}
          />
        )}

        {/* Detail Dialog */}
        <Dialog open={!!selectedLog} onOpenChange={() => setSelectedLog(null)}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Audit Log Details</DialogTitle>
              <DialogDescription>
                {selectedLog && format(new Date(selectedLog.created_at), "MMMM d, yyyy 'at' HH:mm:ss")}
              </DialogDescription>
            </DialogHeader>
            
            {selectedLog && (
              <div className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <Label className="text-muted-foreground">Action</Label>
                    <div className="mt-1">{getActionBadge(selectedLog.action)}</div>
                  </div>
                  <div>
                    <Label className="text-muted-foreground">Entity Type</Label>
                    <p className="font-medium">{selectedLog.entity_type}</p>
                  </div>
                  {selectedLog.entity_name && (
                    <div>
                      <Label className="text-muted-foreground">Entity Name</Label>
                      <p className="font-medium">{selectedLog.entity_name}</p>
                    </div>
                  )}
                  {selectedLog.entity_id && (
                    <div>
                      <Label className="text-muted-foreground">Entity ID</Label>
                      <p className="font-mono text-sm">{selectedLog.entity_id}</p>
                    </div>
                  )}
                </div>

                {selectedLog.changes_summary && (
                  <div>
                    <Label className="text-muted-foreground">Changes Summary</Label>
                    <p>{selectedLog.changes_summary}</p>
                  </div>
                )}

                {selectedLog.old_values && Object.keys(selectedLog.old_values).length > 0 && (
                  <div>
                    <Label className="text-muted-foreground">Previous Values</Label>
                    <ScrollArea className="h-32 rounded border p-2 mt-1">
                      <pre className="text-xs">
                        {JSON.stringify(selectedLog.old_values, null, 2)}
                      </pre>
                    </ScrollArea>
                  </div>
                )}

                {selectedLog.new_values && Object.keys(selectedLog.new_values).length > 0 && (
                  <div>
                    <Label className="text-muted-foreground">New Values</Label>
                    <ScrollArea className="h-32 rounded border p-2 mt-1">
                      <pre className="text-xs">
                        {JSON.stringify(selectedLog.new_values, null, 2)}
                      </pre>
                    </ScrollArea>
                  </div>
                )}

                <div className="grid gap-4 md:grid-cols-2 pt-4 border-t">
                  {selectedLog.ip_address && (
                    <div>
                      <Label className="text-muted-foreground">IP Address</Label>
                      <p className="font-mono text-sm">{selectedLog.ip_address}</p>
                    </div>
                  )}
                  {selectedLog.user_agent && (
                    <div>
                      <Label className="text-muted-foreground">User Agent</Label>
                      <p className="text-sm truncate">{selectedLog.user_agent}</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </PlatformAppLayout>
  );
}
