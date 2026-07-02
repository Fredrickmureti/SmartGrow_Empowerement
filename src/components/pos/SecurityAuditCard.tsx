import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { usePOSSecurityAudit } from "@/hooks/pos/usePOSSecurityAudit";
import { useCurrency } from "@/hooks/useCurrency";
import { format } from "date-fns";
import { 
  Shield, 
  AlertTriangle, 
  UserCheck, 
  Clock, 
  XCircle,
  CheckCircle,
  Activity,
  FileWarning,
  Loader2
} from "lucide-react";
import { cn } from "@/lib/utils";

interface SecurityAuditCardProps {
  registerId?: string;
}

export function SecurityAuditCard({ registerId }: SecurityAuditCardProps) {
  const [selectedType, setSelectedType] = useState<string>("all");
  const { 
    managerOverrides: overrides, 
    isOverridesLoading, 
    sessionAudit: sessions, 
    isSessionsLoading, 
    securityViolations: violations, 
    auditSummary 
  } = usePOSSecurityAudit({ registerId });
  const { formatCurrency } = useCurrency();

  // Create a summary object with the expected property names
  const summary = {
    totalOverrides: auditSummary?.total_overrides || 0,
    activeSessions: auditSummary?.active_sessions || 0,
    highRiskViolations: auditSummary?.high_risk_violations || 0,
  };

  const filteredOverrides = selectedType === "all" 
    ? overrides 
    : overrides.filter(o => o.override_type === selectedType);

  const getActionIcon = (type: string) => {
    switch (type) {
      case "void_transaction":
        return <XCircle className="h-4 w-4 text-red-500" />;
      case "discount_over_limit":
        return <Activity className="h-4 w-4 text-amber-500" />;
      case "refund":
        return <FileWarning className="h-4 w-4 text-orange-500" />;
      case "manual_price":
      case "price_change":
        return <AlertTriangle className="h-4 w-4 text-yellow-500" />;
      default:
        return <Shield className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const getActionBadge = (type: string) => {
    const variants: Record<string, string> = {
      void_transaction: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
      discount_over_limit: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
      refund: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
      manual_price: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
      price_change: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
      no_sale: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
    };
    return variants[type] || "bg-muted text-muted-foreground";
  };

  if (isOverridesLoading || isSessionsLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <Shield className="h-4 w-4 text-primary" />
              <span className="text-sm text-muted-foreground">Total Overrides</span>
            </div>
            <p className="text-2xl font-bold mt-1">{summary?.totalOverrides || 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <UserCheck className="h-4 w-4 text-green-500" />
              <span className="text-sm text-muted-foreground">Active Sessions</span>
            </div>
            <p className="text-2xl font-bold mt-1">{summary?.activeSessions || 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              <span className="text-sm text-muted-foreground">Violations</span>
            </div>
            <p className="text-2xl font-bold mt-1 text-amber-600">{violations?.length || 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-blue-500" />
              <span className="text-sm text-muted-foreground">High-Risk</span>
            </div>
            <p className="text-2xl font-bold mt-1 text-red-600">{summary?.highRiskViolations || 0}</p>
          </CardContent>
        </Card>
      </div>

      {/* Violations Alert */}
      {violations && violations.length > 0 && (
        <Card className="border-amber-200 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-900/10">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2 text-amber-700 dark:text-amber-400">
              <AlertTriangle className="h-4 w-4" />
              Security Violations Detected
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {violations.map((v, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-amber-800 dark:text-amber-300">
                  <AlertTriangle className="h-3 w-3 mt-1 shrink-0" />
                  <span>{v.description}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Tabs for Overrides and Sessions */}
      <Tabs defaultValue="overrides">
        <TabsList>
          <TabsTrigger value="overrides">Manager Overrides</TabsTrigger>
          <TabsTrigger value="sessions">Cashier Sessions</TabsTrigger>
        </TabsList>

        <TabsContent value="overrides" className="space-y-4">
          <div className="flex items-center gap-2">
            <Select value={selectedType} onValueChange={setSelectedType}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="Filter by type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="void_transaction">Voids</SelectItem>
                <SelectItem value="discount_over_limit">Discounts</SelectItem>
                <SelectItem value="refund">Refunds</SelectItem>
                <SelectItem value="manual_price">Price Overrides</SelectItem>
                <SelectItem value="no_sale">Cash Drawer</SelectItem>
              </SelectContent>
            </Select>
            <Badge variant="secondary">{filteredOverrides.length} records</Badge>
          </div>

          <Card>
            <ScrollArea className="h-[400px]">
              {filteredOverrides.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <CheckCircle className="h-10 w-10 mb-2 opacity-30" />
                  <p>No overrides found</p>
                </div>
              ) : (
                <div className="divide-y">
                  {filteredOverrides.map((override) => (
                    <div key={override.id} className="p-4 hover:bg-muted/50">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex items-start gap-3">
                          {getActionIcon(override.override_type)}
                          <div>
                            <div className="flex items-center gap-2 flex-wrap">
                              <Badge className={cn("text-xs", getActionBadge(override.override_type))}>
                                {override.override_type.replace(/_/g, " ")}
                              </Badge>
                              {override.register_name && (
                                <span className="text-xs text-muted-foreground">
                                  @ {override.register_name}
                                </span>
                              )}
                            </div>
                            <p className="text-sm mt-1">
                              Approved by <span className="font-medium">{override.manager_name || "Unknown"}</span>
                            </p>
                            {override.override_reason && (
                              <p className="text-sm text-muted-foreground mt-1">
                                Reason: {override.override_reason}
                              </p>
                            )}
                            {(override.original_value !== null || override.new_value !== null) && (
                              <p className="text-xs text-muted-foreground mt-1">
                                Value: {formatCurrency(override.original_value || 0)} → {formatCurrency(override.new_value || 0)}
                              </p>
                            )}
                          </div>
                        </div>
                        <div className="text-right text-xs text-muted-foreground shrink-0">
                          <p>{format(new Date(override.approved_at), "MMM d, yyyy")}</p>
                          <p>{format(new Date(override.approved_at), "h:mm a")}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </Card>
        </TabsContent>

        <TabsContent value="sessions" className="space-y-4">
          <Card>
            <ScrollArea className="h-[400px]">
              {sessions.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <Clock className="h-10 w-10 mb-2 opacity-30" />
                  <p>No sessions found</p>
                </div>
              ) : (
                <div className="divide-y">
                  {sessions.map((session) => (
                    <div key={session.id} className="p-4 hover:bg-muted/50">
                      <div className="flex items-start justify-between gap-4">
                        <div className="flex items-start gap-3">
                          <div className={cn(
                            "p-2 rounded-full",
                            session.status === "active" ? "bg-green-100 dark:bg-green-900/30" : "bg-muted"
                          )}>
                            <UserCheck className={cn(
                              "h-4 w-4",
                              session.status === "active" ? "text-green-600" : "text-muted-foreground"
                            )} />
                          </div>
                          <div>
                            <p className="font-medium">{session.cashier_name || "Unknown Cashier"}</p>
                            <p className="text-sm text-muted-foreground">
                              {session.register_name || "Unknown Register"}
                            </p>
                            <div className="flex items-center gap-2 mt-1">
                              <Badge variant={session.status === "active" ? "default" : "secondary"}>
                                {session.status}
                              </Badge>
                            </div>
                          </div>
                        </div>
                        <div className="text-right text-xs text-muted-foreground shrink-0">
                          <p>Started: {format(new Date(session.started_at), "h:mm a")}</p>
                          {session.ended_at && (
                            <p>Ended: {format(new Date(session.ended_at), "h:mm a")}</p>
                          )}
                          <p className="mt-1">{format(new Date(session.started_at), "MMM d, yyyy")}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
