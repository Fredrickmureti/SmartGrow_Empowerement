import React from "react";

interface DetailRowProps {
  icon: React.ElementType;
  label: string;
  value: React.ReactNode;
}

/**
 * Shared detail row component for entity detail dialogs.
 * Displays an icon, label, and value in a consistent layout.
 */
export function DetailRow({ icon: Icon, label, value }: DetailRowProps) {
  return (
    <div className="flex items-start gap-2 min-w-0">
      <Icon className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-sm font-medium break-words [overflow-wrap:anywhere]">{value}</div>
      </div>
    </div>
  );
}
