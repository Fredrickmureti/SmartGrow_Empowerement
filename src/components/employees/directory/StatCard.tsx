import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const ACCENT_CLASSES: Record<string, string> = {
  amber: "border-l-4 border-l-amber-500",
  blue: "border-l-4 border-l-blue-500",
  purple: "border-l-4 border-l-purple-500",
  emerald: "border-l-4 border-l-emerald-500",
  rose: "border-l-4 border-l-rose-500",
};

export function StatCard({
  label,
  value,
  icon: Icon,
  accent,
  description,
  onClick,
}: {
  label: string;
  value: string;
  icon: any;
  accent?: "amber" | "blue" | "purple" | "emerald" | "rose";
  description?: string;
  onClick?: () => void;
}) {
  const accentClass = accent ? ACCENT_CLASSES[accent] : "";
  const interactiveClass = onClick ? "cursor-pointer hover:shadow-md transition-shadow" : "";
  return (
    <Card className={`${accentClass} ${interactiveClass}`.trim()} onClick={onClick}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">{label}</CardTitle>
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold text-primary">{value}</div>
        {description && (
          <p className="text-xs text-muted-foreground mt-1">{description}</p>
        )}
      </CardContent>
    </Card>
  );
}