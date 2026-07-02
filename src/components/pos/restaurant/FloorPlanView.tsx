/**
 * Floor Plan View Component
 * 
 * Displays the restaurant floor plan with table statuses for the POS.
 */

import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useFloorPlan, POSTable } from "@/hooks/pos/useFloorPlan";
import { useTableSessions } from "@/hooks/pos/useTableSessions";
import { useTableBookings } from "@/hooks/pos/useTableBookings";
import { useAuth } from "@/contexts/AuthContext";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { 
  Users, 
  Clock, 
  Settings, 
  Plus,
  LayoutGrid,
  Calendar,
  ChefHat,
  ArrowLeft
} from "lucide-react";
import { cn } from "@/lib/utils";
import { TableCard } from "./TableCard";
import { TableSessionDialog } from "./TableSessionDialog";
import { Skeleton } from "@/components/ui/skeleton";

interface FloorPlanViewProps {
  registerId?: string;
  shiftId?: string;
  onTableSelect?: (tableId: string, sessionId?: string) => void;
}

export function FloorPlanView({ registerId, shiftId, onTableSelect }: FloorPlanViewProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { floors, isLoadingFloors, useFloorTables } = useFloorPlan();
  const { openTable } = useTableSessions(shiftId);
  const { upcomingBookings } = useTableBookings();
  const { user } = useAuth();
  
  const [selectedFloorId, setSelectedFloorId] = useState<string | null>(null);
  const [selectedTable, setSelectedTable] = useState<POSTable | null>(null);
  const [showSessionDialog, setShowSessionDialog] = useState(false);

  // Use first active floor if none selected
  const activeFloorId = selectedFloorId || (floors.find(f => f.is_active)?.id ?? null);
  const { data: tables = [], isLoading: isLoadingTables } = useFloorTables(activeFloorId);

  // Real-time subscription for table session changes
  useEffect(() => {
    const channel = supabase
      .channel(`floor-plan-sessions-${activeFloorId || 'all'}-${Date.now()}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "pos_table_sessions",
        },
        () => {
          queryClient.invalidateQueries({ queryKey: ["pos-tables", activeFloorId] });
          queryClient.invalidateQueries({ queryKey: ["pos-table-sessions"] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  const handleTableClick = (table: POSTable) => {
    if (table.current_session) {
      // Table is occupied - navigate to terminal with this session
      if (onTableSelect) {
        onTableSelect(table.id, table.current_session.id);
      } else {
        navigate(`/pos/terminal/${registerId}?table=${table.id}&session=${table.current_session.id}&tableNumber=${encodeURIComponent(table.table_number)}`);
      }
    } else {
      // Table is available - show dialog to open
      setSelectedTable(table);
      setShowSessionDialog(true);
    }
  };

  const handleOpenTable = async (guestsCount: number, notes?: string) => {
    if (!selectedTable) return;
    
    const session = await openTable.mutateAsync({
      table_id: selectedTable.id,
      shift_id: shiftId,
      guests_count: guestsCount,
      notes,
      server_id: user?.id || null,
    });
    
    setShowSessionDialog(false);
    
    if (onTableSelect) {
      onTableSelect(selectedTable.id, session.id);
    } else {
      navigate(`/pos/terminal/${registerId}?table=${selectedTable.id}&session=${session.id}&tableNumber=${encodeURIComponent(selectedTable.table_number)}`);
    }
  };

  const getTableStatusCounts = () => {
    const counts = {
      available: 0,
      occupied: 0,
      reserved: 0,
      pending_payment: 0,
    };
    
    tables.forEach(table => {
      if (table.current_session) {
        counts[table.current_session.status as keyof typeof counts]++;
      } else {
        counts.available++;
      }
    });
    
    return counts;
  };

  const statusCounts = getTableStatusCounts();

  if (isLoadingFloors) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-10 w-64" />
        <div className="grid grid-cols-4 gap-4">
          {[1, 2, 3, 4].map(i => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (floors.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] text-center p-6">
        <LayoutGrid className="h-16 w-16 text-muted-foreground mb-4" />
        <h2 className="text-xl font-semibold mb-2">No Floor Plans Configured</h2>
        <p className="text-muted-foreground mb-4 max-w-md">
          Create floor plans and tables to use restaurant mode. You can add multiple floors
          like Main Floor, Patio, or Terrace.
        </p>
        <Button onClick={() => navigate("/pos/settings?tab=restaurant")}>
          <Settings className="h-4 w-4 mr-2" />
          Configure Floors
        </Button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between p-3 sm:p-4 border-b bg-background gap-2 sm:gap-0">
        <div className="flex items-center gap-2 sm:gap-4 min-w-0">
          <Button variant="ghost" size="icon" className="shrink-0" onClick={() => navigate("/pos")}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="min-w-0">
            <h1 className="text-base sm:text-xl font-semibold truncate">Floor Plan</h1>
            <p className="text-xs sm:text-sm text-muted-foreground truncate">Select a table to start an order</p>
          </div>
        </div>
        
        <div className="flex items-center gap-1.5 sm:gap-2 w-full sm:w-auto overflow-x-auto pl-10 sm:pl-0 pb-1 sm:pb-0">
          {/* Status summary */}
          <div className="flex items-center gap-1.5 sm:gap-2 mr-1 sm:mr-4">
            <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200 text-xs sm:text-sm whitespace-nowrap shrink-0">
              {statusCounts.available} Available
            </Badge>
            <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200 text-xs sm:text-sm whitespace-nowrap shrink-0">
              {statusCounts.occupied} Occupied
            </Badge>
            {statusCounts.reserved > 0 && (
              <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 text-xs sm:text-sm whitespace-nowrap shrink-0">
                {statusCounts.reserved} Reserved
              </Badge>
            )}
          </div>
          
          <Button variant="outline" size="sm" className="shrink-0 text-xs sm:text-sm h-8 sm:h-9 px-2 sm:px-3" onClick={() => navigate("/pos/bookings")}>
            <Calendar className="h-3.5 w-3.5 sm:h-4 sm:w-4 mr-1 sm:mr-2" />
            <span className="hidden xs:inline">Bookings</span>
            {upcomingBookings.length > 0 && (
              <Badge variant="secondary" className="ml-1 sm:ml-2 text-xs">{upcomingBookings.length}</Badge>
            )}
          </Button>
          
          <Button variant="outline" size="sm" className="shrink-0 text-xs sm:text-sm h-8 sm:h-9 px-2 sm:px-3" onClick={() => navigate("/pos/kitchen")}>
            <ChefHat className="h-3.5 w-3.5 sm:h-4 sm:w-4 mr-1 sm:mr-2" />
            <span className="hidden xs:inline">Kitchen</span>
          </Button>
        </div>
      </div>

      {/* Floor Tabs */}
      {floors.length > 1 && (
        <div className="border-b px-4 py-2">
          <Tabs value={activeFloorId || ""} onValueChange={setSelectedFloorId}>
            <TabsList>
              {floors.filter(f => f.is_active).map(floor => (
                <TabsTrigger key={floor.id} value={floor.id}>
                  {floor.name}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      )}

      {/* Floor Plan Canvas */}
      <div 
        className="flex-1 overflow-auto p-3 sm:p-6 bg-muted/30"
      >
        {isLoadingTables ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
            {[1, 2, 3, 4, 5, 6].map(i => (
              <Skeleton key={i} className="h-32 w-full rounded-lg" />
            ))}
          </div>
        ) : tables.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-center">
            <Plus className="h-12 w-12 text-muted-foreground mb-3" />
            <p className="text-muted-foreground">No tables on this floor</p>
            <Button 
              variant="link" 
              onClick={() => navigate("/pos/settings?tab=restaurant")}
            >
              Add tables
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {tables.map(table => (
              <TableCard
                key={table.id}
                table={table}
                onClick={() => handleTableClick(table)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Session Dialog */}
      <TableSessionDialog
        open={showSessionDialog}
        onOpenChange={setShowSessionDialog}
        table={selectedTable}
        onConfirm={handleOpenTable}
        isLoading={openTable.isPending}
      />
    </div>
  );
}
