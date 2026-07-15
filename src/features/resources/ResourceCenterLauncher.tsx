/**
 * ResourceCenterLauncher — global "?" button in the workspace topbar.
 *
 * Pattern mirrors Stripe / Linear / Notion: a persistent help affordance
 * that opens a right-side sheet listing product-tour videos, filtered by
 * the app the user is currently in. The full library lives at
 * `/resources` — this launcher is the fast path.
 *
 * Data source: `platform_demo_videos`. RLS filters to published videos;
 * signed-in users see everything published (including audience='authenticated'
 * internal tutorials).
 */
import { useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { HelpCircle, Play, Search, ArrowRight } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useDemoVideos, type DemoVideo } from "@/hooks/useDemoVideos";
import { labelForAppKey } from "./appOptions";

function inferAppFromPath(pathname: string): string | null {
  const seg = pathname.split("/").filter(Boolean)[0];
  if (!seg) return null;
  const map: Record<string, string> = {
    dashboard: "dashboard",
    home: "dashboard",
    finance: "finance",
    receivables: "finance",
    payables: "finance",
    accounts: "finance",
    "journal-entries": "finance",
    banking: "finance",
    reconciliation: "finance",
    sales: "sales",
    invoices: "sales",
    estimates: "sales",
    orders: "sales",
    customers: "sales",
    purchases: "purchases",
    bills: "purchases",
    vendors: "purchases",
    inventory: "inventory",
    warehouses: "inventory",
    products: "inventory",
    pos: "pos",
    payroll: "payroll",
    hr: "hr",
    employees: "employees",
    me: "me",
    projects: "projects",
    "projects-app": "projects",
    crm: "crm",
    reports: "reports",
    settings: "platform",
    apps: "platform",
    team: "platform",
    resources: null as unknown as string,
  };
  return map[seg] ?? null;
}

function formatDuration(sec: number | null): string {
  if (!sec) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function VideoRow({ video, onSelect }: { video: DemoVideo; onSelect: () => void }) {
  const thumb = video.thumbnail_url;
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-start gap-3 rounded-md border border-transparent p-2 text-left hover:border-border hover:bg-muted/50 transition-colors"
    >
      <div className="relative aspect-video w-24 shrink-0 overflow-hidden rounded bg-muted">
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <Play className="h-5 w-5 text-muted-foreground" />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="line-clamp-2 text-sm font-medium text-foreground">
          {video.title}
        </div>
        <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>{labelForAppKey(video.app_key)}</span>
          {video.duration_seconds ? (
            <>
              <span>·</span>
              <span>{formatDuration(video.duration_seconds)}</span>
            </>
          ) : null}
          {video.difficulty ? (
            <Badge variant="outline" className="ml-1 h-4 px-1 text-[10px]">
              {video.difficulty === "intro" ? "Intro" : "Deep dive"}
            </Badge>
          ) : null}
        </div>
      </div>
    </button>
  );
}

export function ResourceCenterLauncher() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { videos, isLoading } = useDemoVideos(true);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const currentAppKey = inferAppFromPath(pathname);

  const { forThisApp, gettingStarted, everythingElse } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (v: DemoVideo) =>
      !q ||
      v.title.toLowerCase().includes(q) ||
      (v.description?.toLowerCase().includes(q) ?? false);
    const filtered = videos.filter(match);
    const forThisApp = currentAppKey
      ? filtered.filter((v) => v.app_key === currentAppKey)
      : [];
    const gettingStarted = filtered.filter(
      (v) => v.app_key === "getting-started" && (!currentAppKey || v.app_key !== currentAppKey),
    );
    const seen = new Set([...forThisApp, ...gettingStarted].map((v) => v.id));
    const everythingElse = filtered.filter((v) => !seen.has(v.id));
    return { forThisApp, gettingStarted, everythingElse };
  }, [videos, query, currentAppKey]);

  const openVideo = (v: DemoVideo) => {
    setOpen(false);
    navigate(`/resources/${v.id}`);
  };

  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={() => setOpen(true)}
        aria-label="Resource center"
      >
        <HelpCircle className="h-4 w-4" />
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md p-0 flex flex-col">
          <SheetHeader className="px-5 pt-5 pb-3 border-b">
            <SheetTitle>Resource center</SheetTitle>
            <SheetDescription>
              Product tours, tutorials, and getting-started guides.
            </SheetDescription>
            <div className="relative pt-2">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search videos…"
                className="h-8 pl-8"
              />
            </div>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-3 py-3">
            {isLoading ? (
              <div className="space-y-2">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            ) : videos.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                No resources published yet.
              </div>
            ) : (
              <div className="space-y-5">
                {currentAppKey && forThisApp.length > 0 && (
                  <section>
                    <h3 className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      For {labelForAppKey(currentAppKey)}
                    </h3>
                    <div className="space-y-1">
                      {forThisApp.map((v) => (
                        <VideoRow key={v.id} video={v} onSelect={() => openVideo(v)} />
                      ))}
                    </div>
                  </section>
                )}
                {gettingStarted.length > 0 && (
                  <section>
                    <h3 className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Getting started
                    </h3>
                    <div className="space-y-1">
                      {gettingStarted.map((v) => (
                        <VideoRow key={v.id} video={v} onSelect={() => openVideo(v)} />
                      ))}
                    </div>
                  </section>
                )}
                {everythingElse.length > 0 && (
                  <section>
                    <h3 className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      More resources
                    </h3>
                    <div className="space-y-1">
                      {everythingElse.map((v) => (
                        <VideoRow key={v.id} video={v} onSelect={() => openVideo(v)} />
                      ))}
                    </div>
                  </section>
                )}
              </div>
            )}
          </div>

          <div className="border-t p-3">
            <Button variant="outline" className="w-full justify-between" asChild>
              <Link to="/resources" onClick={() => setOpen(false)}>
                <span>Browse full library</span>
                <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

export default ResourceCenterLauncher;
