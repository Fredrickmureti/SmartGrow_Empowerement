/**
 * Studio → Fields workbench.
 *
 * Three-pane layout: entity rail (left) · field workbench (center).
 * Entity selection is URL-routed at /studio/fields/:entityType so deep
 * links and the back button work. Custom + Core fields are presented as
 * sibling sections of one catalog instead of being hidden behind tabs.
 */

import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  ENTITY_TYPE_LABELS,
  EntityType,
  useAllEntityFields,
} from "@/hooks/useEntityFields";
import { useSavedViews } from "@/hooks/useSavedViews";
import { useFormLayouts } from "@/hooks/useFormLayouts";
import { EntityFieldSettings } from "@/components/studio/EntityFieldSettings";
import { CoreFieldsManager } from "@/components/studio/CoreFieldsManager";
import { DocumentFieldPlacer } from "@/components/studio/DocumentFieldPlacer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import {
  Users,
  UsersRound,
  FileSpreadsheet,
  FileText,
  Banknote,
  HandCoins,
  Receipt,
  DollarSign,
  UserCheck,
  PhoneCall,
  Search,
  ShieldAlert,
  Layers,
  Tag,
  LayoutPanelTop,
  type LucideIcon,
} from "lucide-react";
import {
  ENTITY_GROUPS,
  FINANCIAL_ENTITY_TYPES,
  DOCUMENT_ENTITY_TYPES,
} from "@/lib/studio/entities";

const ENTITY_ICONS: Record<EntityType, LucideIcon> = {
  mf_client: Users,
  mf_group: UsersRound,
  mf_loan_application: FileText,
  mf_loan: FileSpreadsheet,
  mf_disbursement: Banknote,
  mf_repayment: Receipt,
  mf_collection_activity: PhoneCall,
  mf_loan_product: HandCoins,
  employee: UserCheck,
  expense: DollarSign,
};

type WorkbenchView = "catalog" | "document";

const STORAGE_KEY = "studio.fields.lastEntity";

function isEntityType(value: string | undefined): value is EntityType {
  return !!value && value in ENTITY_TYPE_LABELS;
}

export default function StudioFields() {
  const navigate = useNavigate();
  const { entityType: paramEntity } = useParams<{ entityType?: string }>();

  const initialEntity: EntityType = useMemo(() => {
    if (isEntityType(paramEntity)) return paramEntity;
    if (typeof window !== "undefined") {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (isEntityType(stored ?? undefined)) return stored as EntityType;
    }
    return "mf_client";
  }, [paramEntity]);

  const [selectedEntity, setSelectedEntity] = useState<EntityType>(initialEntity);
  const [view, setView] = useState<WorkbenchView>("catalog");
  const [search, setSearch] = useState("");

  // Sync URL → state and persist last choice.
  useEffect(() => {
    if (isEntityType(paramEntity) && paramEntity !== selectedEntity) {
      setSelectedEntity(paramEntity);
    } else if (!paramEntity) {
      navigate(`/studio/fields/${initialEntity}`, { replace: true });
    }
  }, [paramEntity, initialEntity, navigate, selectedEntity]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, selectedEntity);
    }
  }, [selectedEntity]);

  // If user switches to an entity without a document template, fall back.
  useEffect(() => {
    if (view === "document" && !DOCUMENT_ENTITY_TYPES.has(selectedEntity)) {
      setView("catalog");
    }
  }, [view, selectedEntity]);

  const selectEntity = (entity: EntityType) => {
    navigate(`/studio/fields/${entity}`);
  };

  const { getFieldCountByEntityType, isLoading: fieldsLoading } =
    useAllEntityFields();
  const { views } = useSavedViews(selectedEntity);
  const { layouts } = useFormLayouts(selectedEntity);

  const fieldCounts = fieldsLoading
    ? ({} as Record<EntityType, number>)
    : getFieldCountByEntityType();
  const customFieldCount = fieldCounts[selectedEntity] ?? 0;
  const isFinancial = FINANCIAL_ENTITY_TYPES.has(selectedEntity);
  const supportsDocument = DOCUMENT_ENTITY_TYPES.has(selectedEntity);

  const entityLabel = ENTITY_TYPE_LABELS[selectedEntity];
  const SelectedIcon = ENTITY_ICONS[selectedEntity];

  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return ENTITY_GROUPS;
    return ENTITY_GROUPS.map((group) => ({
      ...group,
      entities: group.entities.filter((entity) =>
        ENTITY_TYPE_LABELS[entity].toLowerCase().includes(q),
      ),
    })).filter((group) => group.entities.length > 0);
  }, [search]);

  return (
    <div className="flex min-h-[calc(100dvh-var(--workspace-header-height,52px))] flex-col bg-background lg:h-[calc(100dvh-var(--workspace-header-height,52px))] lg:min-h-0">
      {/* Page header — flat, no card chrome. */}
      <header className="border-b bg-background px-4 pb-3 pt-4 sm:px-6 sm:pb-4 sm:pt-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between lg:gap-4">
          <div className="min-w-0">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Studio
            </p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="text-xl font-semibold leading-tight tracking-tight sm:text-2xl">
                Fields
              </h1>
              <span className="hidden text-muted-foreground/40 sm:inline">·</span>
              <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground sm:text-base">
                <SelectedIcon className="h-4 w-4 shrink-0" />
                <span className="truncate font-medium text-foreground">
                  {entityLabel}
                </span>
              </div>
              {isFinancial && (
                <Badge
                  variant="outline"
                  className="gap-1 whitespace-nowrap border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
                >
                  <ShieldAlert className="h-3 w-3" />
                  Financial — metadata only
                </Badge>
              )}
            </div>
            <p className="mt-1 hidden text-sm text-muted-foreground sm:block">
              Schema workbench — manage the fields that power forms, list views,
              and document templates for every entity in the system.
            </p>
          </div>

          {/* Inline metrics — context, not a dashboard. */}
          <div className="grid grid-cols-3 gap-3 rounded-lg border bg-card px-3 py-2 sm:gap-6 sm:px-4 lg:flex lg:shrink-0 lg:items-center">
            <Metric
              icon={Tag}
              label="Custom fields"
              value={customFieldCount}
            />
            <Metric
              icon={LayoutPanelTop}
              label="Form layouts"
              value={layouts.length}
            />
            <Metric icon={Layers} label="Saved views" value={views.length} />
          </div>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[260px_minmax(0,1fr)]">
        {/* Entity rail */}
        <aside className="hidden border-r bg-muted/20 lg:flex lg:flex-col">
          <div className="border-b p-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Find entity…"
                className="h-8 pl-8 text-sm"
              />
            </div>
          </div>
          <ScrollArea className="flex-1">
            <nav className="space-y-4 p-3">
              {filteredGroups.map((group) => (
                <div key={group.label}>
                  <div className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {group.label}
                  </div>
                  <ul className="space-y-0.5">
                    {group.entities.map((entity) => {
                      const Icon = ENTITY_ICONS[entity];
                      const count = fieldCounts[entity] ?? 0;
                      const isActive = entity === selectedEntity;
                      const isFin = FINANCIAL_ENTITY_TYPES.has(entity);
                      return (
                        <li key={entity}>
                          <button
                            type="button"
                            onClick={() => selectEntity(entity)}
                            className={cn(
                              "group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                              isActive
                                ? "bg-primary/10 text-primary"
                                : "text-foreground/80 hover:bg-muted hover:text-foreground",
                            )}
                          >
                            <Icon
                              className={cn(
                                "h-4 w-4 shrink-0",
                                isActive
                                  ? "text-primary"
                                  : "text-muted-foreground",
                              )}
                            />
                            <span className="flex-1 truncate text-left">
                              {ENTITY_TYPE_LABELS[entity]}
                            </span>
                            {isFin && (
                              <span
                                title="Financial entity — custom fields are metadata only"
                                className="h-1.5 w-1.5 rounded-full bg-amber-400"
                              />
                            )}
                            {count > 0 && (
                              <span
                                className={cn(
                                  "rounded px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
                                  isActive
                                    ? "bg-primary/15 text-primary"
                                    : "bg-muted text-muted-foreground",
                                )}
                              >
                                {count}
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </nav>
          </ScrollArea>
        </aside>

        {/* Workbench */}
        <main className="min-w-0 flex-1 lg:min-h-0 lg:overflow-auto">
          {/* Mobile entity picker */}
          <div className="border-b bg-background px-4 py-3 lg:hidden">
            <label
              htmlFor="studio-fields-entity"
              className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
            >
              Entity
            </label>
            <select
              id="studio-fields-entity"
              value={selectedEntity}
              onChange={(e) => selectEntity(e.target.value as EntityType)}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            >
              {ENTITY_GROUPS.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.entities.map((entity) => (
                    <option key={entity} value={entity}>
                      {ENTITY_TYPE_LABELS[entity]}
                      {(fieldCounts[entity] ?? 0) > 0
                        ? ` (${fieldCounts[entity]})`
                        : ""}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>

          {/* Segmented view switcher — only "Catalog" and "Document layout" */}
          <div className="sticky top-0 z-10 flex items-center gap-3 border-b bg-background/95 px-4 py-2.5 backdrop-blur sm:px-6 sm:py-3">
            <div className="inline-flex min-w-0 flex-1 rounded-md border bg-muted/40 p-0.5 text-sm sm:flex-none">
              <ViewTab
                active={view === "catalog"}
                onClick={() => setView("catalog")}
              >
                Catalog
              </ViewTab>
              <ViewTab
                active={view === "document"}
                onClick={() => setView("document")}
                disabled={!supportsDocument}
                title={
                  supportsDocument
                    ? undefined
                    : "This entity has no document template"
                }
              >
                Document layout
              </ViewTab>
            </div>
            <div className="ml-auto hidden text-xs text-muted-foreground sm:block">
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono">
                {selectedEntity}
              </code>
            </div>
          </div>

          <div className="px-3 py-4 sm:px-6 sm:py-6">

            {view === "catalog" ? (
              <div className="space-y-8">
                {/* Custom fields — primary work surface */}
                <WorkbenchSection
                  eyebrow="Custom"
                  title="Custom fields"
                  description={`Org-defined metadata captured on every ${entityLabel.toLowerCase()} record.`}
                >
                  <EntityFieldSettings
                    key={`custom-${selectedEntity}`}
                    entityType={selectedEntity}
                    title="Custom fields"
                    description={`Add and manage custom fields for ${entityLabel.toLowerCase()}.`}
                  />
                </WorkbenchSection>

                {/* Core fields — secondary surface */}
                <WorkbenchSection
                  eyebrow="Core"
                  title="Core fields"
                  description="Built-in fields you can rename, hide, or reorder. Protected fields stay required."
                >
                  <CoreFieldsManager
                    key={`core-${selectedEntity}`}
                    entityType={selectedEntity}
                  />
                </WorkbenchSection>
              </div>
            ) : supportsDocument ? (
              <WorkbenchSection
                eyebrow="Document"
                title="Document layout"
                description={`Drop custom fields onto the ${entityLabel.toLowerCase()} PDF template.`}
              >
                <DocumentFieldPlacer
                  key={`placer-${selectedEntity}`}
                  entityType={selectedEntity}
                />
              </WorkbenchSection>
            ) : (
              <div className="flex flex-col items-center justify-center rounded-lg border border-dashed py-16 text-center">
                <FileText className="mb-3 h-10 w-10 text-muted-foreground/60" />
                <h3 className="text-sm font-semibold">No document template</h3>
                <p className="mt-1 max-w-sm text-xs text-muted-foreground">
                  {entityLabel} records aren't rendered as PDFs, so there's no
                  document surface to place fields on.
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-4"
                  onClick={() => setView("catalog")}
                >
                  Back to catalog
                </Button>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
}) {
  return (
    <div className="flex items-center gap-2">
      <Icon className="h-4 w-4 text-muted-foreground" />
      <div className="leading-tight">
        <div className="text-base font-semibold tabular-nums">{value}</div>
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
      </div>
    </div>
  );
}

function ViewTab({
  active,
  onClick,
  disabled,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={cn(
        "flex-1 truncate whitespace-nowrap rounded px-3 py-1.5 text-xs font-medium transition-colors sm:flex-none sm:text-sm",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
        disabled && "cursor-not-allowed opacity-50 hover:text-muted-foreground",
      )}
    >
      {children}
    </button>
  );
}

function WorkbenchSection({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-primary">
          {eyebrow}
        </span>
        <h2 className="text-base font-semibold">{title}</h2>
        <p className="hidden text-xs text-muted-foreground md:block">
          {description}
        </p>
      </div>
      {children}
    </section>
  );
}
