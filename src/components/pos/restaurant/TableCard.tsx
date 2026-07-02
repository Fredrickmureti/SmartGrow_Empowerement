/**
 * Table Card Component
 * 
 * Visual representation of a table on the floor plan.
 */

import { POSTable } from "@/hooks/pos/useFloorPlan";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Users, Clock, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";

interface TableCardProps {
  table: POSTable;
  onClick?: () => void;
  selected?: boolean;
  showDragHandle?: boolean;
}

export function TableCard({ table, onClick, selected, showDragHandle }: TableCardProps) {
  const session = table.current_session;
  
  const getStatusColor = () => {
    if (!session) return "bg-green-50 dark:bg-green-950/40 border-green-200 dark:border-green-800 hover:bg-green-100 dark:hover:bg-green-900/50";

    switch (session.status) {
      case "open":
      case "ordered":
        return "bg-blue-50 dark:bg-blue-950/40 border-blue-300 dark:border-blue-800 hover:bg-blue-100 dark:hover:bg-blue-900/50";
      case "served":
        return "bg-amber-50 dark:bg-amber-950/40 border-amber-300 dark:border-amber-800 hover:bg-amber-100 dark:hover:bg-amber-900/50";
      case "paid":
        return "bg-purple-50 dark:bg-purple-950/40 border-purple-300 dark:border-purple-800 hover:bg-purple-100 dark:hover:bg-purple-900/50";
      default:
        return "bg-green-50 dark:bg-green-950/40 border-green-200 dark:border-green-800 hover:bg-green-100 dark:hover:bg-green-900/50";
    }
  };

  const getStatusBadge = () => {
    if (!session) {
      return <Badge variant="outline" className="bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300 border-green-300 dark:border-green-700">Available</Badge>;
    }

    switch (session.status) {
      case "open":
      case "ordered":
        return <Badge variant="outline" className="bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-700">Occupied</Badge>;
      case "served":
        return <Badge variant="outline" className="bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-700">Served</Badge>;
      case "paid":
        return <Badge variant="outline" className="bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300 border-purple-300 dark:border-purple-700">Bill</Badge>;
      default:
        return null;
    }
  };

  const getTimeIndicator = () => {
    if (!session?.opened_at) return null;
    
    const openedAt = new Date(session.opened_at);
    const minutesOpen = Math.floor((Date.now() - openedAt.getTime()) / 60000);
    
    // Warning if open for more than 90 minutes
    const isLongWait = minutesOpen > 90;
    
    return (
      <div className={cn(
        "flex items-center gap-1 text-xs",
        isLongWait ? "text-amber-600" : "text-muted-foreground"
      )}>
        {isLongWait && <AlertCircle className="h-3 w-3" />}
        <Clock className="h-3 w-3" />
        <span>{formatDistanceToNow(openedAt, { addSuffix: false })}</span>
      </div>
    );
  };

  const shapeClass = table.shape === "round" 
    ? "rounded-full aspect-square" 
    : table.shape === "rectangle"
    ? "rounded-lg aspect-[3/2]"
    : "rounded-lg aspect-square";

  return (
    <Card
      className={cn(
        "relative cursor-pointer transition-all border-2",
        getStatusColor(),
        selected && "ring-2 ring-primary ring-offset-2",
        shapeClass
      )}
      onClick={onClick}
      style={{
        width: table.width || 120,
        height: table.shape === "rectangle" ? (table.height || 80) : (table.width || 120),
      }}
    >
      <div className="absolute inset-0 flex flex-col items-center justify-center p-2">
        {/* Table Number */}
        <span className="text-2xl font-bold text-foreground">{table.table_number}</span>
        
        {/* Guests */}
        <div className="flex items-center gap-1 text-sm text-muted-foreground mt-1">
          <Users className="h-3.5 w-3.5" />
          <span>{session?.guests_count || 0}/{table.seats}</span>
        </div>
        
        {/* Status Badge */}
        <div className="mt-2">
          {getStatusBadge()}
        </div>
        
        {/* Time Indicator */}
        {session && (
          <div className="mt-1">
            {getTimeIndicator()}
          </div>
        )}
      </div>
      
      {/* Drag Handle (for editor) */}
      {showDragHandle && (
        <div className="absolute top-1 right-1 p-1 cursor-move opacity-50 hover:opacity-100">
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="9" cy="5" r="2" />
            <circle cx="15" cy="5" r="2" />
            <circle cx="9" cy="12" r="2" />
            <circle cx="15" cy="12" r="2" />
            <circle cx="9" cy="19" r="2" />
            <circle cx="15" cy="19" r="2" />
          </svg>
        </div>
      )}
    </Card>
  );
}
