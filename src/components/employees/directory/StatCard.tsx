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
    <Card
      className={`@container/stat min-w-0 ${accentClass} ${interactiveClass}`.trim()}
      onClick={onClick}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2 min-w-0">
          <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground min-w-0">
            {label}
          </CardTitle>
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        </div>
      </CardHeader>
      <CardContent className="min-w-0">
        {/* Value scales with the card's own width — never truncated, never wrapped mid-number */}
        <div className="min-w-0 text-primary font-bold tabular-nums whitespace-nowrap leading-tight text-[clamp(1.05rem,7.5cqi,1.5rem)]">
          {value}
        </div>
        {description && (
          <p className="text-xs text-muted-foreground mt-1 break-words">{description}</p>
        )}
      </CardContent>
    </Card>
  );
}
