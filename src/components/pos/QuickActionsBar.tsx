import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { 
  Receipt, 
  RotateCcw, 
  Wallet,
  FileText,
  Calculator,
  Keyboard,
  Percent
} from "lucide-react";

interface QuickActionsBarProps {
  onHistory: () => void;
  onReturn: () => void;
  onDrawer: () => void;
  onReport: () => void;
  onDiscount: () => void;
  onPayment: () => void;
  hasItems: boolean;
}

export function QuickActionsBar({
  onHistory,
  onReturn,
  onDrawer,
  onReport,
  onDiscount,
  onPayment,
  hasItems,
}: QuickActionsBarProps) {
  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }

      // F1 - Help/Keyboard shortcuts (can be implemented)
      // F2 - Customer
      // F3 - Discount
      if (e.key === "F3") {
        e.preventDefault();
        if (hasItems) onDiscount();
      }
      // F4 - Hold
      // F5 - Recall
      // F6 - History
      if (e.key === "F6") {
        e.preventDefault();
        onHistory();
      }
      // F7 - Return
      if (e.key === "F7") {
        e.preventDefault();
        onReturn();
      }
      // F8 - Drawer
      if (e.key === "F8") {
        e.preventDefault();
        onDrawer();
      }
      // F9 - Report
      if (e.key === "F9") {
        e.preventDefault();
        onReport();
      }
      // F12 or Enter - Payment
      if (e.key === "F12") {
        e.preventDefault();
        if (hasItems) onPayment();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [hasItems, onHistory, onReturn, onDrawer, onReport, onDiscount, onPayment]);

  return (
    <TooltipProvider>
      <div className="flex items-center gap-1 p-2 bg-muted/50 rounded-lg">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" onClick={onHistory}>
              <Receipt className="h-4 w-4 mr-1" />
              <span className="hidden sm:inline">History</span>
              <kbd className="hidden lg:inline ml-2 px-1.5 py-0.5 text-xs bg-muted rounded">F6</kbd>
            </Button>
          </TooltipTrigger>
          <TooltipContent>View Transaction History (F6)</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" onClick={onReturn}>
              <RotateCcw className="h-4 w-4 mr-1" />
              <span className="hidden sm:inline">Return</span>
              <kbd className="hidden lg:inline ml-2 px-1.5 py-0.5 text-xs bg-muted rounded">F7</kbd>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Process Return (F7)</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" onClick={onDrawer}>
              <Wallet className="h-4 w-4 mr-1" />
              <span className="hidden sm:inline">Drawer</span>
              <kbd className="hidden lg:inline ml-2 px-1.5 py-0.5 text-xs bg-muted rounded">F8</kbd>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Cash Drawer (F8)</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" onClick={onReport}>
              <FileText className="h-4 w-4 mr-1" />
              <span className="hidden sm:inline">X Report</span>
              <kbd className="hidden lg:inline ml-2 px-1.5 py-0.5 text-xs bg-muted rounded">F9</kbd>
            </Button>
          </TooltipTrigger>
          <TooltipContent>View Shift Report (F9)</TooltipContent>
        </Tooltip>

        <Separator orientation="vertical" className="h-6 mx-1" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button 
              variant="ghost" 
              size="sm" 
              onClick={onDiscount}
              disabled={!hasItems}
            >
              <Percent className="h-4 w-4 mr-1" />
              <span className="hidden sm:inline">Discount</span>
              <kbd className="hidden lg:inline ml-2 px-1.5 py-0.5 text-xs bg-muted rounded">F3</kbd>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Apply Discount (F3)</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button 
              variant="default" 
              size="sm" 
              onClick={onPayment}
              disabled={!hasItems}
            >
              <Calculator className="h-4 w-4 mr-1" />
              Pay
              <kbd className="hidden lg:inline ml-2 px-1.5 py-0.5 text-xs bg-background/20 rounded">F12</kbd>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Process Payment (F12)</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  );
}
