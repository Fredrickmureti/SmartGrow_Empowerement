/**
 * Vendor Portal Dashboard - Activity feed, deadline warnings, better empty states
 */
import { useVendorPortal } from "@/hooks/useVendorPortal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Package, ClipboardList, Clock, CheckCircle, AlertTriangle, ArrowRight, Inbox } from "lucide-react";
import { Link } from "react-router-dom";

export default function VendorDashboard() {
  const { portalData, purchaseOrders, rfqs } = useVendorPortal();

  const openPOs = purchaseOrders.filter(po => !["received", "cancelled"].includes(po.status));
  const pendingRFQs = rfqs.filter(r => r.vendor_status === "pending");
  const completedPOs = purchaseOrders.filter(po => po.status === "received");

  // RFQs with deadlines approaching (within 48 hours)
  const urgentRFQs = rfqs.filter(r => {
    if (!r.deadline || r.vendor_status !== "pending") return false;
    const diff = new Date(r.deadline).getTime() - Date.now();
    return diff > 0 && diff < 48 * 60 * 60 * 1000;
  });

  // Recent POs (last 7 days)
  const recentPOs = purchaseOrders.filter(po => {
    const daysDiff = (Date.now() - new Date(po.order_date).getTime()) / (1000 * 60 * 60 * 24);
    return daysDiff <= 7;
  });

  // POs with upcoming delivery
  const upcomingDeliveries = purchaseOrders.filter(po => {
    if (!po.expected_date || ["received", "cancelled"].includes(po.status)) return false;
    const diff = new Date(po.expected_date).getTime() - Date.now();
    return diff > 0 && diff < 14 * 24 * 60 * 60 * 1000;
  });

  const hasNoData = purchaseOrders.length === 0 && rfqs.length === 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-foreground">
          Welcome, {portalData.contactName}
        </h2>
        <p className="text-muted-foreground mt-1">
          Here's your overview with {portalData.organizationName || "Organization"}
        </p>
      </div>

      {/* Urgent alerts */}
      {urgentRFQs.length > 0 && (
        <Card className="border-orange-300 dark:border-orange-700 bg-orange-50 dark:bg-orange-950/20">
          <CardContent className="pt-4 pb-4">
            <div className="flex items-center gap-2 text-orange-600 font-medium mb-2">
              <AlertTriangle className="h-5 w-5" />
              {urgentRFQs.length} RFQ{urgentRFQs.length > 1 ? "s" : ""} with deadline approaching
            </div>
            <div className="space-y-1">
              {urgentRFQs.map(rfq => (
                <Link
                  key={rfq.id}
                  to={`/vendor-portal/rfqs/${rfq.id}`}
                  className="flex items-center justify-between text-sm p-2 rounded hover:bg-orange-100 dark:hover:bg-orange-900/20"
                >
                  <span className="font-medium">{rfq.rfq_number}</span>
                  <span className="text-muted-foreground">
                    Due: {new Date(rfq.deadline!).toLocaleDateString()}
                  </span>
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Stats Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center">
                <Package className="h-5 w-5 text-blue-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{openPOs.length}</p>
                <p className="text-sm text-muted-foreground">Open POs</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-orange-100 dark:bg-orange-900/30 flex items-center justify-center">
                <ClipboardList className="h-5 w-5 text-orange-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{pendingRFQs.length}</p>
                <p className="text-sm text-muted-foreground">Pending RFQs</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                <CheckCircle className="h-5 w-5 text-green-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{completedPOs.length}</p>
                <p className="text-sm text-muted-foreground">Completed</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-purple-100 dark:bg-purple-900/30 flex items-center justify-center">
                <Clock className="h-5 w-5 text-purple-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{purchaseOrders.length}</p>
                <p className="text-sm text-muted-foreground">Total POs</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Empty state */}
      {hasNoData && (
        <Card>
          <CardContent className="py-12 flex flex-col items-center text-center">
            <Inbox className="h-12 w-12 text-muted-foreground/40 mb-4" />
            <h3 className="text-lg font-semibold text-foreground mb-2">No activity yet</h3>
            <p className="text-sm text-muted-foreground max-w-md">
              You haven't received any purchase orders or RFQ requests yet.
              When {portalData.organizationName || "the organization"} sends you orders or requests for quotation, they will appear here.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Activity Columns */}
      {!hasNoData && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Recent POs + Upcoming Deliveries */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center justify-between">
                Recent Purchase Orders
                <Link to="/vendor-portal/purchase-orders" className="text-sm text-primary font-normal hover:underline flex items-center gap-1">
                  View all <ArrowRight className="h-3 w-3" />
                </Link>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {purchaseOrders.length === 0 ? (
                <p className="text-sm text-muted-foreground">No purchase orders yet.</p>
              ) : (
                <div className="space-y-3">
                  {purchaseOrders.slice(0, 5).map(po => (
                    <Link
                      key={po.id}
                      to={`/vendor-portal/purchase-orders/${po.id}`}
                      className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 transition-colors"
                    >
                      <div>
                        <p className="font-medium text-sm">{po.po_number}</p>
                        <p className="text-xs text-muted-foreground">
                          {new Date(po.order_date).toLocaleDateString()}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">
                          {po.currency} {po.total.toLocaleString()}
                        </span>
                        <Badge variant={po.status === "received" ? "default" : "secondary"} className="text-xs">
                          {po.status}
                        </Badge>
                      </div>
                    </Link>
                  ))}
                </div>
              )}

              {/* Upcoming deliveries */}
              {upcomingDeliveries.length > 0 && (
                <div className="mt-4 pt-4 border-t">
                  <p className="text-sm font-medium text-muted-foreground mb-2">Upcoming Deliveries</p>
                  {upcomingDeliveries.map(po => (
                    <Link
                      key={po.id}
                      to={`/vendor-portal/purchase-orders/${po.id}`}
                      className="flex items-center justify-between text-sm p-2 rounded hover:bg-muted/50"
                    >
                      <span>{po.po_number}</span>
                      <span className="text-muted-foreground">
                        {new Date(po.expected_date!).toLocaleDateString()}
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* RFQ Requests */}
          <Card>
            <CardHeader>
              <CardTitle className="text-lg flex items-center justify-between">
                RFQ Requests
                <Link to="/vendor-portal/rfqs" className="text-sm text-primary font-normal hover:underline flex items-center gap-1">
                  View all <ArrowRight className="h-3 w-3" />
                </Link>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {rfqs.length === 0 ? (
                <p className="text-sm text-muted-foreground">No RFQ requests yet.</p>
              ) : (
                <div className="space-y-3">
                  {rfqs.slice(0, 5).map(rfq => (
                    <Link
                      key={rfq.id}
                      to={`/vendor-portal/rfqs/${rfq.id}`}
                      className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 transition-colors"
                    >
                      <div>
                        <p className="font-medium text-sm">{rfq.rfq_number}</p>
                        {rfq.deadline && (
                          <p className="text-xs text-muted-foreground">
                            Due: {new Date(rfq.deadline).toLocaleDateString()}
                          </p>
                        )}
                      </div>
                      <Badge
                        variant={rfq.vendor_status === "pending" ? "destructive" : "secondary"}
                        className="text-xs"
                      >
                        {rfq.vendor_status}
                      </Badge>
                    </Link>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
