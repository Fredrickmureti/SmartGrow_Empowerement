/**
 * Floor Plan Page
 * 
 * Displays the restaurant floor plan for table selection.
 */

import { useParams, useSearchParams } from "react-router-dom";
import { FloorPlanView } from "@/components/pos/restaurant/FloorPlanView";
import { usePOSShifts } from "@/hooks/pos/usePOSShifts";

export default function FloorPlan() {
  const { registerId } = useParams<{ registerId: string }>();
  const [searchParams] = useSearchParams();
  const shiftId = searchParams.get("shift") || undefined;
  const { userCurrentShift } = usePOSShifts();
  
  // Use the current shift ID if available
  const activeShiftId = shiftId || userCurrentShift?.id;

  return (
    <div className="h-screen bg-background">
      <FloorPlanView 
        registerId={registerId} 
        shiftId={activeShiftId}
      />
    </div>
  );
}
