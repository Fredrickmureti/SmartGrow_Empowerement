/**
 * EmptyStateRail — uniform first-run rail for empty Attendance surfaces
 * (Devices, Roster, Shifts). Reduces "blank page" cognitive load with a
 * short headline, 2-3 ordered setup steps, and a single primary CTA.
 */
import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { LucideIcon } from "lucide-react";

interface Props {
  icon: LucideIcon;
  headline: string;
  steps: string[];
  cta?: { label: string; onClick: () => void };
  children?: ReactNode;
}

export function EmptyStateRail({ icon: Icon, headline, steps, cta, children }: Props) {
  return (
    <Card>
      <CardContent className="p-6 sm:p-8">
        <div className="flex flex-col sm:flex-row items-start gap-4 sm:gap-6">
          <div className="h-12 w-12 rounded-full bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <Icon className="h-6 w-6" />
          </div>
          <div className="flex-1 min-w-0 space-y-3">
            <div>
              <h3 className="text-base font-semibold">{headline}</h3>
            </div>
            <ol className="list-decimal list-inside space-y-1 text-sm text-muted-foreground">
              {steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
            {children}
            {cta && (
              <div className="pt-1">
                <Button onClick={cta.onClick} size="sm">
                  {cta.label}
                </Button>
              </div>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
