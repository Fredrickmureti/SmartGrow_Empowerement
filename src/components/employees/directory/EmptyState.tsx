import { Users } from "lucide-react";

export function EmptyState({ totalEmployees }: { totalEmployees: number }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center px-4">
      <Users className="h-12 w-12 text-muted-foreground mb-4" />
      <h3 className="text-lg font-medium">No employees found</h3>
      <p className="text-muted-foreground text-sm">
        {totalEmployees === 0
          ? "Get started by adding your first employee."
          : "Try adjusting your search or filters."}
      </p>
    </div>
  );
}