/**
 * EntityInspectorPane — read-only, publisher-facing summary card for
 * localization editors whose artefact is a single "entity" record
 * rather than a document or a spreadsheet (statutory authorities, pack
 * requirements, publisher governance, garnishment policies).
 *
 * Same slot contract as the other preview panes: the editor derives a
 * label/value grid + relationship chips from live form state, and this
 * pane renders them in the workspace's preview drawer.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, LayoutTemplate } from "lucide-react";
import { cn } from "@/lib/utils";

export interface EntityInspectorField {
  label: string;
  value: React.ReactNode;
  hint?: string;
  emphasize?: boolean;
  fullWidth?: boolean;
}

export interface EntityInspectorGroup {
  title: string;
  fields: EntityInspectorField[];
}

export interface EntityInspectorChip {
  label: string;
  tone?: "default" | "success" | "warning" | "destructive" | "outline";
}

export interface EntityInspectorPaneProps {
  title?: string;
  subtitle?: string;
  kindLabel?: string;
  chips?: EntityInspectorChip[];
  groups: EntityInspectorGroup[];
  warnings?: string[];
  error?: string | null;
  footnote?: string;
  className?: string;
}

const CHIP_VARIANTS: Record<NonNullable<EntityInspectorChip["tone"]>, string> = {
  default: "bg-muted text-muted-foreground",
  success: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30",
  warning: "bg-amber-500/10 text-amber-800 dark:text-amber-300 border border-amber-500/30",
  destructive: "bg-destructive/10 text-destructive border border-destructive/30",
  outline: "border border-border text-muted-foreground",
};

export function EntityInspectorPane({
  title = "Entity preview",
  subtitle,
  kindLabel,
  chips = [],
  groups,
  warnings = [],
  error,
  footnote,
  className,
}: EntityInspectorPaneProps) {
  return (
    <Card className={cn("flex h-full min-h-0 w-full flex-col overflow-hidden border-0 shadow-none", className)}>
      <CardHeader className="shrink-0 pb-2 flex-row items-center justify-between space-y-0">
        <CardTitle className="flex items-center gap-2 text-sm">
          <LayoutTemplate className="h-4 w-4" /> {title}
          {kindLabel && (
            <Badge variant="outline" className="text-[10px]">{kindLabel}</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}

        {chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {chips.map((c, i) => (
              <span
                key={i}
                className={cn("rounded px-2 py-0.5 text-[10px] font-medium", CHIP_VARIANTS[c.tone ?? "default"])}
              >
                {c.label}
              </span>
            ))}
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription className="break-all text-xs">{error}</AlertDescription>
          </Alert>
        )}

        {groups.length === 0 && !error && (
          <div className="flex flex-1 items-center justify-center rounded border border-dashed bg-muted/20 p-6 text-center text-xs text-muted-foreground">
            Select or create a record in the editor to preview it here.
          </div>
        )}

        {groups.map((g, gi) => (
          <section key={gi} className="rounded border bg-background">
            <header className="border-b bg-muted/30 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {g.title}
            </header>
            <dl className="grid grid-cols-1 gap-x-4 gap-y-2 p-3 sm:grid-cols-2">
              {g.fields.map((f, fi) => (
                <div key={fi} className={cn("flex flex-col gap-0.5", f.fullWidth && "sm:col-span-2")}>
                  <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{f.label}</dt>
                  <dd className={cn("text-xs", f.emphasize && "font-semibold text-foreground")}>
                    {f.value === null || f.value === undefined || f.value === ""
                      ? <span className="italic text-muted-foreground">—</span>
                      : f.value}
                  </dd>
                  {f.hint && <p className="text-[10px] text-muted-foreground/80">{f.hint}</p>}
                </div>
              ))}
            </dl>
          </section>
        ))}

        {warnings.length > 0 && (
          <div className="rounded border border-amber-300/60 bg-amber-50/40 p-2 text-[10px] text-amber-900 dark:bg-amber-950/20 dark:text-amber-200">
            <ul className="list-disc pl-4 space-y-0.5">
              {warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          </div>
        )}

        {footnote && (
          <p className="mt-auto shrink-0 text-[10px] italic text-muted-foreground/80">{footnote}</p>
        )}
      </CardContent>
    </Card>
  );
}

export default EntityInspectorPane;