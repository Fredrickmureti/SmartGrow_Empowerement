import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";
import {
  Calendar,
  Search,
  MoreVertical,
  Mail,
  CheckCircle,
  XCircle,
  Clock,
  Phone,
  Building2,
  MessageSquare,
  RefreshCw,
  Inbox,
} from "lucide-react";
import { DemoRequestDetailsDialog } from "@/components/admin/DemoRequestDetailsDialog";
import { useNavigate } from "react-router-dom";
import { normalizeError } from "@/services/resilience";

interface DemoRequest {
  id: string;
  full_name: string;
  email: string;
  company_name: string | null;
  phone: string | null;
  message: string | null;
  status: string;
  admin_notes: string | null;
  created_at: string;
  updated_at: string;
  contacted_at: string | null;
  contacted_by: string | null;
}

const statusConfig: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ReactNode }> = {
  pending: { label: "Pending", variant: "secondary", icon: <Clock className="h-3 w-3" /> },
  contacted: { label: "Contacted", variant: "default", icon: <Mail className="h-3 w-3" /> },
  completed: { label: "Completed", variant: "outline", icon: <CheckCircle className="h-3 w-3" /> },
  cancelled: { label: "Cancelled", variant: "destructive", icon: <XCircle className="h-3 w-3" /> },
};

export default function AdminDemoRequests() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [selectedRequest, setSelectedRequest] = useState<DemoRequest | null>(null);
  const openReply = (request: DemoRequest) =>
    navigate(`/admin-management/demo-requests/${request.id}/reply`);

  const { data: requests, isLoading, refetch } = useQuery({
    queryKey: ["demo-requests", statusFilter],
    queryFn: async () => {
      let query = supabase
        .from("demo_requests")
        .select("*")
        .order("created_at", { ascending: false });

      if (statusFilter !== "all") {
        query = query.eq("status", statusFilter);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data as DemoRequest[];
    },
  });

  const updateStatusMutation = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const updates: Record<string, any> = { status };
      
      if (status === "contacted") {
        const { data: { user } } = await supabase.auth.getUser();
        updates.contacted_at = new Date().toISOString();
        updates.contacted_by = user?.id;
      }

      const { error } = await supabase
        .from("demo_requests")
        .update(updates as any)
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["demo-requests"] });
      toast({ title: "Status updated successfully" });
    },
    onError: (error: any) => {
      toast({
        title: "Failed to update status",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    },
  });

  const filteredRequests = requests?.filter((request) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      request.full_name.toLowerCase().includes(query) ||
      request.email.toLowerCase().includes(query) ||
      request.company_name?.toLowerCase().includes(query)
    );
  });

  const stats = {
    total: requests?.length || 0,
    pending: requests?.filter((r) => r.status === "pending").length || 0,
    contacted: requests?.filter((r) => r.status === "contacted").length || 0,
    completed: requests?.filter((r) => r.status === "completed").length || 0,
  };

  return (
    <>
      <div className="space-y-4 sm:space-y-6 p-3 sm:p-6 lg:p-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-lg sm:text-xl lg:text-2xl font-bold flex items-center gap-2">
              <Inbox className="h-4 w-4 sm:h-5 sm:w-5 lg:h-6 lg:w-6" />
              Demo Requests
            </h1>
            <p className="text-xs sm:text-sm text-muted-foreground">
              Manage and respond to demo scheduling requests
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} className="w-full sm:w-auto text-xs sm:text-sm">
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Refresh
          </Button>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
          <Card>
            <CardHeader className="p-3 sm:p-4 pb-1 sm:pb-2">
              <CardDescription className="text-[11px] sm:text-sm">Total Requests</CardDescription>
              <CardTitle className="text-xl sm:text-2xl lg:text-3xl">{stats.total}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="p-3 sm:p-4 pb-1 sm:pb-2">
              <CardDescription className="flex items-center gap-1 text-[11px] sm:text-sm">
                <Clock className="h-2.5 w-2.5 sm:h-3 sm:w-3" /> Pending
              </CardDescription>
              <CardTitle className="text-xl sm:text-2xl lg:text-3xl text-amber-600">{stats.pending}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="p-3 sm:p-4 pb-1 sm:pb-2">
              <CardDescription className="flex items-center gap-1 text-[11px] sm:text-sm">
                <Mail className="h-2.5 w-2.5 sm:h-3 sm:w-3" /> Contacted
              </CardDescription>
              <CardTitle className="text-xl sm:text-2xl lg:text-3xl text-blue-600">{stats.contacted}</CardTitle>
            </CardHeader>
          </Card>
          <Card>
            <CardHeader className="p-3 sm:p-4 pb-1 sm:pb-2">
              <CardDescription className="flex items-center gap-1 text-[11px] sm:text-sm">
                <CheckCircle className="h-2.5 w-2.5 sm:h-3 sm:w-3" /> Completed
              </CardDescription>
              <CardTitle className="text-xl sm:text-2xl lg:text-3xl text-green-600">{stats.completed}</CardTitle>
            </CardHeader>
          </Card>
        </div>

        {/* Filters & Table */}
        <Card>
          <CardHeader className="p-3 sm:p-4 lg:p-6">
            <div className="flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between">
              <div className="relative flex-1 sm:max-w-sm">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 sm:h-4 sm:w-4 text-muted-foreground" />
                <Input
                  placeholder="Search by name, email, or company..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-8 sm:pl-9 text-xs sm:text-sm h-8 sm:h-9"
                />
              </div>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-full sm:w-[160px] text-xs sm:text-sm h-8 sm:h-9">
                  <SelectValue placeholder="Filter by status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all" className="text-xs sm:text-sm">All Statuses</SelectItem>
                  <SelectItem value="pending" className="text-xs sm:text-sm">Pending</SelectItem>
                  <SelectItem value="contacted" className="text-xs sm:text-sm">Contacted</SelectItem>
                  <SelectItem value="completed" className="text-xs sm:text-sm">Completed</SelectItem>
                  <SelectItem value="cancelled" className="text-xs sm:text-sm">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent className="p-3 sm:p-4 lg:p-6 pt-0 sm:pt-0 lg:pt-0">
            {isLoading ? (
              <div className="space-y-3">
                {[...Array(5)].map((_, i) => (
                  <Skeleton key={i} className="h-12 sm:h-16 w-full" />
                ))}
              </div>
            ) : filteredRequests?.length === 0 ? (
              <div className="text-center py-8 sm:py-12">
                <Calendar className="h-8 w-8 sm:h-12 sm:w-12 mx-auto text-muted-foreground mb-3 sm:mb-4" />
                <h3 className="text-sm sm:text-lg font-semibold mb-1 sm:mb-2">No demo requests yet</h3>
                <p className="text-xs sm:text-sm text-muted-foreground">
                  When users schedule demos, they'll appear here.
                </p>
              </div>
            ) : (
              <>
                {/* Desktop table */}
                <div className="rounded-md border hidden sm:block">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-xs sm:text-sm">Contact</TableHead>
                        <TableHead className="text-xs sm:text-sm">Company</TableHead>
                        <TableHead className="text-xs sm:text-sm">Status</TableHead>
                        <TableHead className="text-xs sm:text-sm">Submitted</TableHead>
                        <TableHead className="w-[50px]"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filteredRequests?.map((request) => {
                        const status = statusConfig[request.status] || statusConfig.pending;
                        return (
                          <TableRow
                            key={request.id}
                            className="cursor-pointer hover:bg-muted/50"
                            onClick={() => setSelectedRequest(request)}
                          >
                            <TableCell>
                              <div>
                                <div className="text-xs sm:text-sm font-medium">{request.full_name}</div>
                                <div className="text-[11px] sm:text-sm text-muted-foreground flex items-center gap-1">
                                  <Mail className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
                                  {request.email}
                                </div>
                                {request.phone && (
                                  <div className="text-[11px] sm:text-sm text-muted-foreground flex items-center gap-1">
                                    <Phone className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
                                    {request.phone}
                                  </div>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="text-xs sm:text-sm">
                              {request.company_name ? (
                                <div className="flex items-center gap-1">
                                  <Building2 className="h-3 w-3 text-muted-foreground" />
                                  {request.company_name}
                                </div>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                            <TableCell>
                              <Badge variant={status.variant} className="gap-1 text-[10px] sm:text-xs">
                                {status.icon}
                                {status.label}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <div className="text-xs sm:text-sm">
                                {format(new Date(request.created_at), "MMM d, yyyy")}
                              </div>
                              <div className="text-[10px] sm:text-xs text-muted-foreground">
                                {format(new Date(request.created_at), "h:mm a")}
                              </div>
                            </TableCell>
                            <TableCell>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                                  <Button variant="ghost" size="icon" className="h-7 w-7 sm:h-8 sm:w-8">
                                    <MoreVertical className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setSelectedRequest(request); }}>
                                    <MessageSquare className="h-3.5 w-3.5 mr-2" /> View Details
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={(e) => { e.stopPropagation(); openReply(request); }}>
                                    <Mail className="h-3.5 w-3.5 mr-2" /> Send Email
                                  </DropdownMenuItem>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem onClick={(e) => { e.stopPropagation(); updateStatusMutation.mutate({ id: request.id, status: "contacted" }); }}>
                                    <Mail className="h-3.5 w-3.5 mr-2" /> Mark as Contacted
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={(e) => { e.stopPropagation(); updateStatusMutation.mutate({ id: request.id, status: "completed" }); }}>
                                    <CheckCircle className="h-3.5 w-3.5 mr-2" /> Mark as Completed
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={(e) => { e.stopPropagation(); updateStatusMutation.mutate({ id: request.id, status: "cancelled" }); }} className="text-destructive">
                                    <XCircle className="h-3.5 w-3.5 mr-2" /> Cancel Request
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>

                {/* Mobile card list */}
                <div className="sm:hidden space-y-3">
                  {filteredRequests?.map((request) => {
                    const status = statusConfig[request.status] || statusConfig.pending;
                    return (
                      <Card
                        key={request.id}
                        className="cursor-pointer hover:bg-muted/30 transition-colors"
                        onClick={() => setSelectedRequest(request)}
                      >
                        <CardContent className="p-3 space-y-2">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-xs font-medium truncate">{request.full_name}</p>
                              <p className="text-[10px] text-muted-foreground truncate flex items-center gap-1">
                                <Mail className="h-2.5 w-2.5 shrink-0" />
                                {request.email}
                              </p>
                              {request.phone && (
                                <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                                  <Phone className="h-2.5 w-2.5 shrink-0" />
                                  {request.phone}
                                </p>
                              )}
                            </div>
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                                <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0">
                                  <MoreVertical className="h-3 w-3" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); setSelectedRequest(request); }}>
                                  <MessageSquare className="h-3.5 w-3.5 mr-2" /> View Details
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); openReply(request); }}>
                                  <Mail className="h-3.5 w-3.5 mr-2" /> Send Email
                                </DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); updateStatusMutation.mutate({ id: request.id, status: "contacted" }); }}>
                                  <Mail className="h-3.5 w-3.5 mr-2" /> Mark as Contacted
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); updateStatusMutation.mutate({ id: request.id, status: "completed" }); }}>
                                  <CheckCircle className="h-3.5 w-3.5 mr-2" /> Mark as Completed
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={(e) => { e.stopPropagation(); updateStatusMutation.mutate({ id: request.id, status: "cancelled" }); }} className="text-destructive">
                                  <XCircle className="h-3.5 w-3.5 mr-2" /> Cancel Request
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1.5">
                              {request.company_name && (
                                <span className="text-[10px] text-muted-foreground flex items-center gap-0.5">
                                  <Building2 className="h-2.5 w-2.5" />
                                  {request.company_name}
                                </span>
                              )}
                            </div>
                            <Badge variant={status.variant} className="gap-0.5 text-[10px]">
                              {status.icon}
                              {status.label}
                            </Badge>
                          </div>
                          <p className="text-[10px] text-muted-foreground">
                            {format(new Date(request.created_at), "MMM d, yyyy · h:mm a")}
                          </p>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {selectedRequest && (
        <DemoRequestDetailsDialog
          request={selectedRequest}
          open={!!selectedRequest}
          onOpenChange={(open) => !open && setSelectedRequest(null)}
          onStatusChange={(status) => {
            updateStatusMutation.mutate({ id: selectedRequest.id, status });
          }}
          onComposeEmail={() => openReply(selectedRequest)}
        />
      )}

      {composeFor && (
        <ComposeEmailDialog
          open={!!composeFor}
          onOpenChange={(open) => !open && setComposeFor(null)}
          defaultTo={composeFor.email}
          defaultSubject={`Re: Your AccrualFlow Demo Request${composeFor.company_name ? ` — ${composeFor.company_name}` : ""}`}
          defaultBody={`Hi ${composeFor.full_name.split(" ")[0] || "there"},\n\nThanks for requesting a demo of AccrualFlow${composeFor.company_name ? ` for ${composeFor.company_name}` : ""}. I'd love to set up a time to walk you through the platform.\n\n${composeFor.message ? `You mentioned:\n"${composeFor.message}"\n\n` : ""}A few times that work on my side — let me know which suits you best, or feel free to suggest another slot.\n\nBest,\nThe AccrualFlow Team`}
          lockTo
          title={`Email ${composeFor.full_name}`}
          description="Reply directly without leaving the platform. Attachments and AI assist are supported."
          logMetadata={{
            source: "demo_request",
            demo_request_id: composeFor.id,
            recipient_name: composeFor.full_name,
            company_name: composeFor.company_name,
          }}
          onSent={() => {
            // Auto-mark as contacted if still pending
            if (composeFor.status === "pending") {
              updateStatusMutation.mutate({ id: composeFor.id, status: "contacted" });
            } else {
              queryClient.invalidateQueries({ queryKey: ["demo-requests"] });
            }
            setComposeFor(null);
          }}
        />
      )}
    </>
  );
}
