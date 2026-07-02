import { useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { format } from "date-fns";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  Building2,
  User,
  Users,
  GitBranch,
  Calendar,
  Hash,
  Pencil,
  Trash2,
  ArrowUpRight,
  Mail,
  Phone,
} from "lucide-react";
import type { Department } from "@/hooks/useDepartments";
import type { Employee } from "@/hooks/useEmployees";

interface DepartmentDetailSheetProps {
  department: Department | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  allDepartments: Department[];
  employees: Employee[];
  canManage: boolean;
  onEdit: (dept: Department) => void;
  onDelete: (dept: Department) => void;
}

function getInitials(first?: string, last?: string) {
  return `${first?.[0] ?? ""}${last?.[0] ?? ""}`.toUpperCase() || "?";
}

export function DepartmentDetailSheet({
  department,
  open,
  onOpenChange,
  allDepartments,
  employees,
  canManage,
  onEdit,
  onDelete,
}: DepartmentDetailSheetProps) {
  const subDepartments = useMemo(
    () => (department ? allDepartments.filter((d) => d.parent_department_id === department.id) : []),
    [allDepartments, department]
  );

  const members = useMemo(
    () => (department ? employees.filter((e) => e.department_id === department.id) : []),
    [employees, department]
  );

  if (!department) return null;

  const manager = department.manager
    ? members.find((m) => m.id === department.manager_id)
    : undefined;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-xl p-0 flex flex-col">
        {/* Header band */}
        <div className="border-b bg-muted/30 px-6 pt-6 pb-5">
          <div className="flex items-start gap-4">
            <div className="h-12 w-12 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
              <Building2 className="h-6 w-6" />
            </div>
            <div className="min-w-0 flex-1">
              <SheetHeader className="space-y-1 text-left">
                <SheetTitle className="text-xl leading-tight truncate">
                  {department.name}
                </SheetTitle>
                <SheetDescription className="flex flex-wrap items-center gap-1.5">
                  {department.code && (
                    <Badge variant="outline" className="text-xs font-mono">
                      <Hash className="h-3 w-3 mr-0.5" />
                      {department.code}
                    </Badge>
                  )}
                  <Badge
                    variant="secondary"
                    className={
                      department.is_active
                        ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
                        : "bg-muted text-muted-foreground"
                    }
                  >
                    {department.is_active ? "Active" : "Inactive"}
                  </Badge>
                </SheetDescription>
              </SheetHeader>
            </div>
          </div>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-6 space-y-6">
            {/* Description */}
            {department.description && (
              <section>
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                  About
                </h4>
                <p className="text-sm leading-relaxed text-foreground/90 whitespace-pre-wrap">
                  {department.description}
                </p>
              </section>
            )}

            {/* Quick stats */}
            <section className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border p-3">
                <div className="flex items-center gap-2 text-muted-foreground text-xs">
                  <Users className="h-3.5 w-3.5" /> Members
                </div>
                <div className="text-2xl font-semibold mt-1">{members.length}</div>
              </div>
              <div className="rounded-lg border p-3">
                <div className="flex items-center gap-2 text-muted-foreground text-xs">
                  <GitBranch className="h-3.5 w-3.5" /> Sub-departments
                </div>
                <div className="text-2xl font-semibold mt-1">{subDepartments.length}</div>
              </div>
            </section>

            <Separator />

            {/* Org structure */}
            <section className="space-y-3">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Org structure
              </h4>

              <div className="space-y-3">
                <div className="flex items-start gap-3">
                  <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center shrink-0">
                    <User className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-muted-foreground">Manager</div>
                    {department.manager ? (
                      <div className="text-sm font-medium">
                        {department.manager.first_name} {department.manager.last_name}
                      </div>
                    ) : (
                      <div className="text-sm text-muted-foreground italic">No manager assigned</div>
                    )}
                    {manager?.email && (
                      <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                        <Mail className="h-3 w-3" /> {manager.email}
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-start gap-3">
                  <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center shrink-0">
                    <Building2 className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-muted-foreground">Parent department</div>
                    <div className="text-sm font-medium">
                      {department.parent_department?.name || (
                        <span className="text-muted-foreground italic font-normal">Top level</span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </section>

            {/* Sub-departments */}
            {subDepartments.length > 0 && (
              <>
                <Separator />
                <section className="space-y-2">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Sub-departments
                  </h4>
                  <div className="space-y-1.5">
                    {subDepartments.map((d) => (
                      <div
                        key={d.id}
                        className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <Building2 className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          <span className="font-medium truncate">{d.name}</span>
                          {d.code && (
                            <Badge variant="outline" className="text-[10px] font-mono">
                              {d.code}
                            </Badge>
                          )}
                        </div>
                        {!d.is_active && (
                          <span className="text-xs text-muted-foreground">Inactive</span>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              </>
            )}

            {/* Members preview */}
            <Separator />
            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Members
                </h4>
                {members.length > 5 && (
                  <Button variant="link" size="sm" asChild className="h-auto p-0 text-xs">
                    <Link to="/hr/employees">
                      View all {members.length}
                      <ArrowUpRight className="h-3 w-3 ml-0.5" />
                    </Link>
                  </Button>
                )}
              </div>

              {members.length === 0 ? (
                <div className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                  No employees assigned to this department yet.
                </div>
              ) : (
                <div className="space-y-1.5">
                  {members.slice(0, 5).map((m) => (
                    <div
                      key={m.id}
                      className="flex items-center gap-3 rounded-md border px-3 py-2"
                    >
                      <Avatar className="h-8 w-8">
                        <AvatarFallback className="text-xs">
                          {getInitials(m.first_name, m.last_name)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium truncate">
                          {m.first_name} {m.last_name}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {m.position || m.employment_type || "—"}
                        </div>
                      </div>
                      {m.phone && (
                        <Phone className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Meta */}
            <Separator />
            <section className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <div className="text-muted-foreground flex items-center gap-1">
                  <Calendar className="h-3 w-3" /> Created
                </div>
                <div className="font-medium mt-0.5">
                  {format(new Date(department.created_at), "MMM d, yyyy")}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground flex items-center gap-1">
                  <Calendar className="h-3 w-3" /> Updated
                </div>
                <div className="font-medium mt-0.5">
                  {format(new Date(department.updated_at), "MMM d, yyyy")}
                </div>
              </div>
            </section>
          </div>
        </ScrollArea>

        {/* Sticky actions */}
        {canManage && (
          <div className="border-t bg-background px-6 py-3 flex items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => {
                onOpenChange(false);
                onDelete(department);
              }}
            >
              <Trash2 className="h-4 w-4 mr-1.5" /> Delete
            </Button>
            <Button
              size="sm"
              onClick={() => {
                onOpenChange(false);
                onEdit(department);
              }}
            >
              <Pencil className="h-4 w-4 mr-1.5" /> Edit department
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
