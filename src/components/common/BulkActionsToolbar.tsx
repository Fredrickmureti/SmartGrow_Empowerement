import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Trash2, Download, X } from "lucide-react";

interface BulkActionsToolbarProps {
  selectedCount: number;
  onDelete?: () => void;
  onExport?: () => void;
  onClearSelection: () => void;
  isDeleting?: boolean;
  entityName?: string;
}

export function BulkActionsToolbar({
  selectedCount,
  onDelete,
  onExport,
  onClearSelection,
  isDeleting = false,
  entityName = "items",
}: BulkActionsToolbarProps) {
  if (selectedCount === 0) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: 20 }}
        className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50"
      >
        <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3 rounded-lg border bg-background/95 backdrop-blur-sm shadow-lg px-3 py-2.5 sm:px-4 sm:py-3 mx-3 sm:mx-0 max-w-[calc(100vw-1.5rem)]">
          <span className="text-xs sm:text-sm font-medium text-muted-foreground whitespace-nowrap">
            {selectedCount} {entityName} selected
          </span>
          
          <div className="h-4 w-px bg-border" />
          
          {onExport && (
            <Button
              variant="outline"
              size="sm"
              onClick={onExport}
              className="gap-2"
            >
              <Download className="h-4 w-4" />
              Export
            </Button>
          )}
          
          {onDelete && (
            <Button
              variant="destructive"
              size="sm"
              onClick={onDelete}
              disabled={isDeleting}
              className="gap-2"
            >
              <Trash2 className="h-4 w-4" />
              {isDeleting ? "Deleting..." : "Delete"}
            </Button>
          )}
          
          <Button
            variant="ghost"
            size="icon"
            onClick={onClearSelection}
            className="h-8 w-8"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
