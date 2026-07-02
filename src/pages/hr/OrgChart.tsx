/**
 * Organization Chart — read-only manager tree built from `employees.manager_id`.
 * Pure CSS/SVG, no third-party deps. Scoped via useHrScope so branch-restricted
 * users only see employees in their assigned branches.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ChevronDown, ChevronRight, Loader2, Users } from "lucide-react";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useEmployees, type Employee } from "@/hooks/useEmployees";

interface Node {
  emp: Employee;
  children: Node[];
}

function buildForest(employees: Employee[]): Node[] {
  const byId = new Map<string, Node>();
  employees.forEach((e) => byId.set(e.id, { emp: e, children: [] }));
  const roots: Node[] = [];
  byId.forEach((node) => {
    const mid = node.emp.manager_id;
    if (mid && byId.has(mid)) byId.get(mid)!.children.push(node);
    else roots.push(node);
  });
  const sortRec = (n: Node) => {
    n.children.sort((a, b) =>
      `${a.emp.first_name} ${a.emp.last_name}`.localeCompare(`${b.emp.first_name} ${b.emp.last_name}`),
    );
    n.children.forEach(sortRec);
  };
  roots.sort((a, b) =>
    `${a.emp.first_name} ${a.emp.last_name}`.localeCompare(`${b.emp.first_name} ${b.emp.last_name}`),
  );
  roots.forEach(sortRec);
  return roots;
}

function NodeView({
  node, depth, expanded, toggle, onOpen,
}: {
  node: Node;
  depth: number;
  expanded: Set<string>;
  toggle: (id: string) => void;
  onOpen: (id: string) => void;
}) {
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(node.emp.id);
  return (
    <div style={{ paddingLeft: depth * 16 }}>
      <div className="flex items-center gap-2 py-1.5">
        {hasChildren ? (
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => toggle(node.emp.id)}>
            {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </Button>
        ) : (
          <span className="inline-block w-6" />
        )}
        <button
          onClick={() => onOpen(node.emp.id)}
          className="flex flex-col items-start text-left hover:underline"
        >
          <span className="text-sm font-medium">
            {node.emp.first_name} {node.emp.last_name}
          </span>
          <span className="text-xs text-muted-foreground">
            {node.emp.position || node.emp.department_name || node.emp.employee_number}
          </span>
        </button>
      </div>
      {hasChildren && isOpen && (
        <div className="border-l border-border/60 ml-3">
          {node.children.map((c) => (
            <NodeView
              key={c.emp.id}
              node={c}
              depth={depth + 1}
              expanded={expanded}
              toggle={toggle}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export default function OrgChart() {
  const navigate = useNavigate();
  const { employees, isLoading } = useEmployees();
  const active = useMemo(() => employees.filter((e) => e.is_active), [employees]);
  const forest = useMemo(() => buildForest(active), [active]);

  // Ids of every node that actually has children — the only nodes whose
  // `expanded` flag has any visible effect. Expand/Collapse All operate on
  // this set so the buttons give honest feedback and can be disabled when
  // there's nothing expandable in the current tree.
  const branchableIds = useMemo(() => {
    const ids: string[] = [];
    const walk = (n: Node) => {
      if (n.children.length > 0) {
        ids.push(n.emp.id);
        n.children.forEach(walk);
      }
    };
    forest.forEach(walk);
    return ids;
  }, [forest]);

  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // The lazy useState initializer runs once on mount when employees are still
  // loading, so the initial set is empty and every root renders collapsed.
  // Auto-expand roots the first time the forest actually has data so the
  // chart is useful on first paint (matches the user expectation that the
  // top level is open by default).
  const didAutoExpand = useRef(false);
  useEffect(() => {
    if (didAutoExpand.current) return;
    if (forest.length === 0) return;
    didAutoExpand.current = true;
    setExpanded(new Set(forest.map((n) => n.emp.id)));
  }, [forest]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const expandAll = () => setExpanded(new Set(branchableIds));
  const collapseAll = () => setExpanded(new Set());

  const hasBranches = branchableIds.length > 0;
  const allExpanded = hasBranches && branchableIds.every((id) => expanded.has(id));
  const allCollapsed = expanded.size === 0;

  return (
    <>
      <div className="space-y-4">
        <div className="page-header">
          <div>
            <h1 className="page-title">Organization Chart</h1>
            <p className="text-sm text-muted-foreground">Reporting structure built from employee managers.</p>
          </div>
          <div className="action-buttons">
            <Button
              variant="outline"
              size="sm"
              onClick={expandAll}
              disabled={!hasBranches || allExpanded}
            >
              Expand all
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={collapseAll}
              disabled={!hasBranches || allCollapsed}
            >
              Collapse all
            </Button>
          </div>
        </div>

        <Card>
          <CardContent className="p-4">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : forest.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                <Users className="h-10 w-10 text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">No employees to display.</p>
              </div>
            ) : (
              <div className="space-y-1">
                {forest.map((root) => (
                  <NodeView
                    key={root.emp.id}
                    node={root}
                    depth={0}
                    expanded={expanded}
                    toggle={toggle}
                    onOpen={(id) => navigate(`/hr/employees/${id}`)}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
