import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { 
// SCOPE-TRIGGER-EXEMPT: POS UI mentions 'switch branch' as instruction text; scope is locked to the POS register
  MonitorSmartphone, 
  Plus, 
  Clock, 
  DollarSign,
  ShoppingCart,
  BarChart3,
  Settings,
  Play,
  Pause,
  LayoutGrid,
  ChefHat,
  Calendar,
  Utensils,
  TrendingUp,
  RotateCcw,
  CreditCard,
} from "lucide-react";
import { usePOSRegisters } from "@/hooks/pos/usePOSRegisters";
import { usePOSShifts } from "@/hooks/pos/usePOSShifts";
import { usePOSSettings } from "@/hooks/pos/usePOSSettings";
import { usePOSDashboardStats } from "@/hooks/pos/usePOSDashboardStats";
import { usePermissions } from "@/hooks/usePermissions";
import { useCurrency } from "@/hooks/useCurrency";
import { CreateRegisterDialog } from "@/components/pos/CreateRegisterDialog";
import { OpenShiftDialog } from "@/components/pos/OpenShiftDialog";
import { POSSetupChecklist } from "@/components/pos/POSSetupChecklist";
import { format } from "date-fns";
import { RescueSessionAlert } from "@/components/pos/RescueSessionAlert";
import { POSReadinessBanner, usePOSReadiness } from "@/components/pos/POSReadinessBanner";
import { usePOSSound } from "@/hooks/pos/usePOSSound";
import { usePOSOverseer } from "@/hooks/pos/usePOSOverseer";
import { AlertTriangle } from "lucide-react";

export default function POS() {
  const navigate = useNavigate();
  const { registers, isLoading } = usePOSRegisters();
  const { userCurrentShift, shifts } = usePOSShifts();
  const { restaurantSettings } = usePOSSettings();
  const { stats, isLoading: isStatsLoading, scope } = usePOSDashboardStats();
  const { formatCurrency } = useCurrency();
  const permissions = usePermissions();
  const { data: readiness } = usePOSReadiness();
  const [showCreateRegister, setShowCreateRegister] = useState(false);
  const [showOpenShift, setShowOpenShift] = useState(false);
  const [selectedRegisterId, setSelectedRegisterId] = useState<string | null>(null);
  const sound = usePOSSound();
  // Stage B4 — surface HQ overseer mode so admins aren't blinded but also
  // can't accidentally open a foreign-branch terminal.
  const { isOverseeing } = usePOSOverseer();

  // Default POS payment methods are now seeded by the
  // `trg_seed_pos_payment_methods` trigger when a Company is created.
  // No client-side initialization is needed.

  const hasAnyRestaurantFeature = 
    restaurantSettings.restaurant_mode_enabled || 
    restaurantSettings.kitchen_display_enabled || 
    restaurantSettings.table_bookings_enabled;

  const handleOpenTerminal = (registerId: string) => {
    // Stage B4: overseers see all branches in HQ mode but must switch
    // into the register's branch before operating it.
    if (isOverseeing) return;
    // Block opening a shift if POS isn't fully configured for this company.
    if (readiness && !readiness.ok) {
      return;
    }
    // Check if user has an open shift for this register
    if (userCurrentShift?.register_id === registerId) {
      navigate(`/pos/terminal/${registerId}`);
    } else {
      setSelectedRegisterId(registerId);
      setShowOpenShift(true);
    }
  };

  const handleShiftOpened = () => {
    setShowOpenShift(false);
    sound.play("shift_open");
    if (selectedRegisterId) {
      navigate(`/pos/terminal/${selectedRegisterId}`);
    }
  };

  return (
    <div className="space-y-4 sm:space-y-6">
        {/* Rescue Session Alert */}
        <RescueSessionAlert />
        {/* POS Readiness — blocks sales if mappings are missing */}
        <POSReadinessBanner />
        {/* Header - Responsive */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Point of Sale</h1>
            <p className="text-sm sm:text-base text-muted-foreground">
              Select a register to start selling
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {permissions.canViewPOSReports && (
              <Button variant="outline" size="sm" className="sm:size-default" onClick={() => navigate("/pos/reports")}>
                <BarChart3 className="h-4 w-4 sm:mr-2" />
                <span className="hidden sm:inline">Reports</span>
              </Button>
            )}
            {permissions.canManagePOS && (
              <>
                <Button variant="outline" size="sm" className="sm:size-default" onClick={() => navigate("/pos/settings")}>
                  <Settings className="h-4 w-4 sm:mr-2" />
                  <span className="hidden sm:inline">Settings</span>
                </Button>
                <Button size="sm" 
                  className="sm:size-default" 
                  onClick={() => setShowCreateRegister(true)}
                >
                  <Plus className="h-4 w-4 sm:mr-2" />
                  <span className="hidden xs:inline">Add Register</span>
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Unsynced Shifts Warning */}
        {isOverseeing && (
          <Card className="border-amber-500/50 bg-amber-500/5">
            <CardContent className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 py-3">
              <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span>
                  HQ oversight mode — viewing all branches as read-only. Switch
                  to a specific branch to operate a register.
                </span>
              </div>
              <Badge variant="outline" className="border-amber-500/50 text-amber-700 dark:text-amber-400 w-fit">
                Read-only
              </Badge>
            </CardContent>
          </Card>
        )}

        {(() => {
          const unsyncedShifts = shifts.filter(s => s.status === "closed" && !s.gl_posted_at);
          if (unsyncedShifts.length === 0) return null;
          const plural = unsyncedShifts.length > 1;
          return (
            <Card className="border-yellow-500/50 bg-yellow-500/5">
              <CardContent className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3">
                <div className="flex items-center gap-2 text-sm text-yellow-700 dark:text-yellow-400">
                  <RotateCcw className="h-4 w-4 shrink-0" />
                  <span>
                    {unsyncedShifts.length} closed shift{plural ? "s" : ""} awaiting GL posting.
                    Posting runs automatically via the finance outbox — usually
                    within a minute. Use Review to inspect status or retry.
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="border-yellow-500/50 text-yellow-700 dark:text-yellow-400 w-fit">
                    Action needed
                  </Badge>
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-yellow-500/60 text-yellow-800 dark:text-yellow-300 hover:bg-yellow-500/10"
                    onClick={() => navigate("/finance/operations/accounting-events?state=open")}
                  >
                    Review & Post
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })()}

        {/* First-Run Setup Checklist — superseded by <POSReadinessBanner/> above
            (RPC-driven, GL-aware, self-resolving). Kept as fallback only when
            readiness RPC has not yet returned (e.g. legacy/offline). */}
        {!readiness && <POSSetupChecklist hasShiftHistory={shifts.length > 0} />}

        {/* Current Shift Status - Responsive */}
        {userCurrentShift && (
          <Card className="border-primary/50 bg-primary/5">
            <CardContent className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-3 sm:py-4">
              <div className="flex items-center gap-3 sm:gap-4">
                <div className="h-8 w-8 sm:h-10 sm:w-10 rounded-full bg-primary/20 flex items-center justify-center flex-shrink-0">
                  <Clock className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
                </div>
                <div className="min-w-0">
                  <p className="font-medium text-sm sm:text-base truncate">Active: {userCurrentShift.shift_number}</p>
                  <p className="text-xs sm:text-sm text-muted-foreground truncate">
                    {userCurrentShift.register?.register_name} • Started {format(new Date(userCurrentShift.opened_at), "h:mm a")}
                  </p>
                </div>
              </div>
              <Button size="sm" className="w-full sm:w-auto" onClick={() => navigate(`/pos/terminal/${userCurrentShift.register_id}`)}>
                <Play className="mr-2 h-4 w-4" />
                Continue Selling
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Restaurant Mode Quick Actions */}
        {hasAnyRestaurantFeature && (
          <Card className="border-orange-500/30 bg-orange-500/5">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Utensils className="h-5 w-5 text-orange-500" />
                Restaurant Mode
              </CardTitle>
              <CardDescription>Quick access to restaurant features</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {restaurantSettings.restaurant_mode_enabled && (
                  <Button variant="outline" size="sm" onClick={() => navigate("/pos/floor-plan")}>
                    <LayoutGrid className="h-4 w-4 mr-2" />
                    Floor Plan
                  </Button>
                )}
                {restaurantSettings.kitchen_display_enabled && (
                  <Button variant="outline" size="sm" onClick={() => navigate("/pos/kitchen")}>
                    <ChefHat className="h-4 w-4 mr-2" />
                    Kitchen Display
                  </Button>
                )}
                {restaurantSettings.table_bookings_enabled && (
                  <Button variant="outline" size="sm" onClick={() => navigate("/pos/bookings")}>
                    <Calendar className="h-4 w-4 mr-2" />
                    Reservations
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
          {isLoading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <Card key={i} className="animate-pulse">
                <CardHeader>
                  <div className="h-6 bg-muted rounded w-1/2" />
                  <div className="h-4 bg-muted rounded w-3/4" />
                </CardHeader>
                <CardContent>
                  <div className="h-20 bg-muted rounded" />
                </CardContent>
              </Card>
            ))
          ) : registers.length === 0 ? (
            <Card className="col-span-full">
              <CardContent className="flex flex-col items-center justify-center py-8 sm:py-12 px-4">
                <MonitorSmartphone className="h-10 w-10 sm:h-12 sm:w-12 text-muted-foreground mb-3 sm:mb-4" />
                <h3 className="text-base sm:text-lg font-semibold mb-2 text-center">No Registers Set Up</h3>
                <p className="text-sm text-muted-foreground text-center mb-4">
                  Create your first register to start using the POS system
                </p>
                {permissions.canManagePOS && (
                  <Button size="sm" 
                    onClick={() => setShowCreateRegister(true)}
                  >
                    <Plus className="mr-2 h-4 w-4" />
                    Create Register
                  </Button>
                )}
              </CardContent>
            </Card>
          ) : (
            registers.map((register) => (
              <Card key={register.id} className="hover:shadow-md transition-shadow">
                <CardHeader className="pb-2 p-3 sm:p-6 sm:pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
                        <MonitorSmartphone className="h-4 w-4 sm:h-5 sm:w-5 flex-shrink-0" />
                        <span className="truncate">{register.register_name}</span>
                      </CardTitle>
                      <CardDescription className="text-xs sm:text-sm truncate">
                        Code: {register.register_code}
                        {register.branch && ` • ${register.branch.name}`}
                      </CardDescription>
                    </div>
                    <Badge variant={register.is_active ? "default" : "secondary"} className="text-xs flex-shrink-0">
                      {register.is_active ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="p-3 sm:p-6 pt-0 sm:pt-0">
                  <div className="flex items-center gap-2 sm:gap-4 text-xs sm:text-sm text-muted-foreground mb-3 sm:mb-4">
                    {register.last_active_at && (
                      <span className="truncate">Last: {format(new Date(register.last_active_at), "MMM d, h:mm a")}</span>
                    )}
                  </div>
                  
                  {register.is_active && permissions.canProcessSales && (
                    <Button className="w-full"
                      size="sm"
                      disabled={isOverseeing}
                      title={isOverseeing ? `Switch to ${register.branch?.name ?? "this register's branch"} to operate it` : undefined}
                      onClick={() => handleOpenTerminal(register.id)}
                    >
                      <ShoppingCart className="mr-2 h-4 w-4" />
                      {isOverseeing ? "View only (switch branch)" : "Open Terminal"}
                    </Button>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </div>

        {/* Today's Analytics */}
        {registers.length > 0 && (
          <>
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold">Today's Analytics</h2>
              <Badge variant="outline">{scope.label}</Badge>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
              <Card className="w-full">
                <CardContent className="p-3 sm:p-6 sm:pt-6">
                  <div className="flex items-center gap-3 sm:gap-4">
                    <div className="h-8 w-8 sm:h-10 sm:w-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <DollarSign className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-lg sm:text-2xl font-bold break-all">{formatCurrency(stats.todaySales)}</p>
                      <p className="text-xs sm:text-sm text-muted-foreground">Today's Sales</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card className="w-full">
                <CardContent className="p-3 sm:p-6 sm:pt-6">
                  <div className="flex items-center gap-3 sm:gap-4">
                    <div className="h-8 w-8 sm:h-10 sm:w-10 rounded-lg bg-accent/50 flex items-center justify-center flex-shrink-0">
                      <ShoppingCart className="h-4 w-4 sm:h-5 sm:w-5 text-accent-foreground" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-lg sm:text-2xl font-bold">{stats.todayTransactions}</p>
                      <p className="text-xs sm:text-sm text-muted-foreground">Transactions</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card className="w-full">
                <CardContent className="p-3 sm:p-6 sm:pt-6">
                  <div className="flex items-center gap-3 sm:gap-4">
                    <div className="h-8 w-8 sm:h-10 sm:w-10 rounded-lg bg-secondary flex items-center justify-center flex-shrink-0">
                      <TrendingUp className="h-4 w-4 sm:h-5 sm:w-5 text-secondary-foreground" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-lg sm:text-2xl font-bold break-all">{formatCurrency(stats.averageBasket)}</p>
                      <p className="text-xs sm:text-sm text-muted-foreground">Avg. Basket</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card className="w-full">
                <CardContent className="p-3 sm:p-6 sm:pt-6">
                  <div className="flex items-center gap-3 sm:gap-4">
                    <div className="h-8 w-8 sm:h-10 sm:w-10 rounded-lg bg-destructive/10 flex items-center justify-center flex-shrink-0">
                      <RotateCcw className="h-4 w-4 sm:h-5 sm:w-5 text-destructive" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-lg sm:text-2xl font-bold break-all">{formatCurrency(stats.todayReturns)}</p>
                      <p className="text-xs sm:text-sm text-muted-foreground">Returns</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            {/* Payment Breakdown */}
            {stats.paymentBreakdown.length > 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <CreditCard className="h-5 w-5 text-muted-foreground" />
                    Today's Revenue by Payment Method
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {stats.paymentBreakdown.map((item) => {
                      const pct = stats.todaySales > 0 ? (item.amount / stats.todaySales) * 100 : 0;
                      return (
                        <div key={item.method} className="flex items-center gap-3">
                          <span className="text-sm font-medium capitalize w-20 truncate">{item.method}</span>
                          <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                            <div
                              className="h-full rounded-full bg-primary transition-all"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="text-sm font-medium tabular-nums w-24 text-right">
                            {formatCurrency(item.amount)}
                          </span>
                          <span className="text-xs text-muted-foreground w-12 text-right">
                            {pct.toFixed(0)}%
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Register counts */}
            <div className="grid gap-3 sm:gap-4 grid-cols-2 md:grid-cols-4">
              <Card>
                <CardContent className="p-3 sm:p-6 sm:pt-6">
                  <div className="flex items-center gap-3 sm:gap-4">
                    <div className="h-8 w-8 sm:h-10 sm:w-10 rounded-lg bg-muted flex items-center justify-center flex-shrink-0">
                      <MonitorSmartphone className="h-4 w-4 sm:h-5 sm:w-5 text-muted-foreground" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xl sm:text-2xl font-bold">{registers.length}</p>
                      <p className="text-xs sm:text-sm text-muted-foreground truncate">Total Registers</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card>
                <CardContent className="p-3 sm:p-6 sm:pt-6">
                  <div className="flex items-center gap-3 sm:gap-4">
                    <div className="h-8 w-8 sm:h-10 sm:w-10 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                      <Play className="h-4 w-4 sm:h-5 sm:w-5 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-xl sm:text-2xl font-bold">
                        {registers.filter(r => r.is_active).length}
                      </p>
                      <p className="text-xs sm:text-sm text-muted-foreground truncate">Active Registers</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </>
        )}

      {/* Dialogs */}
      <CreateRegisterDialog 
        open={showCreateRegister} 
        onOpenChange={setShowCreateRegister} 
      />
      
      {selectedRegisterId && (
        <OpenShiftDialog
          open={showOpenShift}
          onOpenChange={setShowOpenShift}
          registerId={selectedRegisterId}
          onShiftOpened={handleShiftOpened}
        />
      )}
    </div>
  );
}
