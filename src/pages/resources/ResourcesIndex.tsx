/**
 * ResourcesIndex — full learning library for signed-in users at `/resources`.
 *
 * Complements the topbar launcher: the launcher is context-aware and fast,
 * this page is browsable — search, group by product area, click through to
 * a full-player detail page.
 */
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader, PageBody, LoadingState, EmptyState } from "@/design-system";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, BookOpen, Play, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDemoVideos, type DemoVideo } from "@/hooks/useDemoVideos";
import {
  RESOURCE_APP_OPTIONS,
  labelForAppKey,
} from "@/features/resources/appOptions";

function formatDuration(sec: number | null): string {
  if (!sec) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function VideoCard({ v }: { v: DemoVideo }) {
  return (
    <Link
      to={`/resources/${v.id}`}
      className="group block overflow-hidden rounded-lg border border-border bg-card transition-all hover:border-primary/40 hover:shadow-sm"
    >
      <div className="relative aspect-video overflow-hidden bg-muted">
        {v.thumbnail_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={v.thumbnail_url}
            alt=""
            className="h-full w-full object-cover transition-transform group-hover:scale-105"
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Play className="h-8 w-8 text-muted-foreground" />
          </div>
        )}
        {v.duration_seconds ? (
          <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium text-white">
            {formatDuration(v.duration_seconds)}
          </span>
        ) : null}
      </div>
      <CardContent className="p-3">
        <div className="flex items-center gap-1.5">
          <Badge variant="outline" className="text-[10px]">
            {labelForAppKey(v.app_key)}
          </Badge>
          {v.difficulty ? (
            <Badge variant="secondary" className="text-[10px]">
              {v.difficulty === "intro" ? "Intro" : "Deep dive"}
            </Badge>
          ) : null}
        </div>
        <h3 className="mt-2 line-clamp-2 text-sm font-semibold text-foreground">
          {v.title}
        </h3>
        {v.description ? (
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
            {v.description}
          </p>
        ) : null}
      </CardContent>
    </Link>
  );
}

export default function ResourcesIndex() {
  const { videos, isLoading } = useDemoVideos(true);
  const [query, setQuery] = useState("");
  const [appFilter, setAppFilter] = useState<string>("all");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return videos.filter((v) => {
      if (appFilter !== "all" && v.app_key !== appFilter) return false;
      if (!q) return true;
      return (
        v.title.toLowerCase().includes(q) ||
        (v.description?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [videos, query, appFilter]);

  const grouped = useMemo(() => {
    const map = new Map<string, DemoVideo[]>();
    for (const v of filtered) {
      const key = v.app_key ?? "__general";
      const arr = map.get(key) ?? [];
      arr.push(v);
      map.set(key, arr);
    }
    // Preserve RESOURCE_APP_OPTIONS order, "general" last.
    const ordered: Array<{ key: string; label: string; videos: DemoVideo[] }> = [];
    for (const opt of RESOURCE_APP_OPTIONS) {
      const list = map.get(opt.key);
      if (list?.length) ordered.push({ key: opt.key, label: opt.label, videos: list });
    }
    const general = map.get("__general");
    if (general?.length) ordered.push({ key: "__general", label: "General", videos: general });
    return ordered;
  }, [filtered]);

  const appOptionsInUse = useMemo(() => {
    const set = new Set(videos.map((v) => v.app_key).filter(Boolean) as string[]);
    return RESOURCE_APP_OPTIONS.filter((o) => set.has(o.key));
  }, [videos]);

  return (
    <>
      <PageHeader
        title="Resource center"
        description="Product tours, tutorials, and getting-started guides for every part of the platform."
        actions={
          <Button variant="outline" asChild>
            <Link to="/home">
              <ArrowLeft className="mr-1 h-4 w-4" /> Back to workspace
            </Link>
          </Button>
        }
      />
      <PageBody>
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative sm:max-w-xs">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search resources…"
              className="pl-8"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setAppFilter("all")}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                appFilter === "all"
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:text-foreground"
              }`}
            >
              All
            </button>
            {appOptionsInUse.map((o) => (
              <button
                key={o.key}
                type="button"
                onClick={() => setAppFilter(o.key)}
                className={`rounded-full border px-3 py-1 text-xs transition ${
                  appFilter === o.key
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>

        {isLoading ? (
          <LoadingState />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            title="No resources match your filters"
            description="Try clearing the search or picking a different product area."
          />
        ) : (
          <div className="space-y-8">
            {grouped.map((section) => (
              <section key={section.key}>
                <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                  {section.label}
                </h2>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {section.videos.map((v) => (
                    <VideoCard key={v.id} v={v} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </PageBody>
    </>
  );
}
