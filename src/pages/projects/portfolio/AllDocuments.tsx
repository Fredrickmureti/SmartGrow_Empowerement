/**
 * AllProjectDocuments — global view of all project documents in scope.
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useProjects } from "@/hooks/projects";
import { format } from "date-fns";
import { FileText } from "lucide-react";
import { RunProjectReportButton } from "@/components/projects/RunProjectReportButton";

interface Doc {
  id: string;
  project_id: string;
  name: string;
  size_bytes: number | null;
  mime_type: string | null;
  created_at: string;
}

function fmtSize(b: number | null) {
  if (!b) return "";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

export default function AllProjectDocuments() {
  const { projects } = useProjects();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    let alive = true;
    async function run() {
      const ids = projects.map((p) => p.id);
      if (ids.length === 0) { setDocs([]); setLoading(false); return; }
      setLoading(true);
      const { data } = await supabase
        .from("project_documents")
        .select("id, project_id, name, size_bytes, mime_type, created_at")
        .in("project_id", ids)
        .order("created_at", { ascending: false })
        .limit(500);
      if (alive) { setDocs((data ?? []) as Doc[]); setLoading(false); }
    }
    void run();
    return () => { alive = false; };
  }, [projects]);

  const projMap = new Map(projects.map((p) => [p.id, p] as const));
  const filtered = docs.filter((d) => !search || d.name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Project Documents</h1>
          <p className="text-muted-foreground text-sm">All documents across your projects.</p>
        </div>
        <RunProjectReportButton reportType="project_status" title="Project documents" label="Print" />
      </div>
      <Input placeholder="Search documents..." value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-sm" />
      <Card>
        <CardContent className="p-0">
          {loading ? <Skeleton className="h-40 w-full" /> : filtered.length === 0 ? (
            <p className="p-6 text-sm text-muted-foreground">No documents.</p>
          ) : (
            <div className="divide-y">
              {filtered.map((d) => (
                <Link key={d.id} to={`/projects-app/${d.project_id}/documents`} className="flex items-center justify-between gap-3 p-3 hover:bg-muted">
                  <div className="flex items-center gap-3 min-w-0">
                    <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{d.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{projMap.get(d.project_id)?.name ?? "—"} · {format(new Date(d.created_at), "MMM d, yyyy")} {d.size_bytes ? `· ${fmtSize(d.size_bytes)}` : ""}</p>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
