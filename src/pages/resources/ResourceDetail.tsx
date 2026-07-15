/**
 * ResourceDetail — full-player page for a single tutorial video at
 * `/resources/:id`. Shows related videos from the same app on the side.
 */
import { useMemo } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { PageHeader, PageBody, LoadingState, EmptyState } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, BookOpen, Play } from "lucide-react";
import { useDemoVideos, type DemoVideo } from "@/hooks/useDemoVideos";
import { labelForAppKey } from "@/features/resources/appOptions";

function getEmbedUrl(url: string): string {
  const yt = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]+)/);
  if (yt) return `https://www.youtube.com/embed/${yt[1]}?rel=0`;
  const vm = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (vm) return `https://player.vimeo.com/video/${vm[1]}`;
  return url;
}

function isDirectVideo(url: string): boolean {
  return /\.(mp4|webm|ogg)$/i.test(url);
}

function formatDuration(sec: number | null): string {
  if (!sec) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function ResourceDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { videos, isLoading } = useDemoVideos(true);

  const video = useMemo(() => videos.find((v) => v.id === id), [videos, id]);
  const related = useMemo(() => {
    if (!video) return [] as DemoVideo[];
    return videos
      .filter((v) => v.id !== video.id && v.app_key === video.app_key)
      .slice(0, 6);
  }, [videos, video]);

  if (isLoading) return <LoadingState />;

  if (!video) {
    return (
      <>
        <PageHeader title="Resource" />
        <PageBody>
          <EmptyState
            icon={BookOpen}
            title="Video not found"
            description="It may have been unpublished. Head back to the library."
            action={
              <Button variant="outline" onClick={() => navigate("/resources")}>
                <ArrowLeft className="mr-1 h-4 w-4" /> Back to library
              </Button>
            }
          />
        </PageBody>
      </>
    );
  }

  const direct = isDirectVideo(video.video_url);

  return (
    <>
      <PageHeader
        title={video.title}
        description={video.description ?? undefined}
        actions={
          <Button variant="outline" asChild>
            <Link to="/resources">
              <ArrowLeft className="mr-1 h-4 w-4" /> Library
            </Link>
          </Button>
        }
      />
      <PageBody>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 space-y-4">
            <div className="aspect-video overflow-hidden rounded-lg border bg-black">
              {direct ? (
                <video
                  src={video.video_url}
                  controls
                  className="h-full w-full"
                  poster={video.thumbnail_url ?? undefined}
                />
              ) : (
                <iframe
                  src={getEmbedUrl(video.video_url)}
                  title={video.title}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  className="h-full w-full"
                />
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{labelForAppKey(video.app_key)}</Badge>
              {video.difficulty ? (
                <Badge variant="secondary">
                  {video.difficulty === "intro" ? "Intro" : "Deep dive"}
                </Badge>
              ) : null}
              {video.duration_seconds ? (
                <span className="text-xs text-muted-foreground">
                  {formatDuration(video.duration_seconds)}
                </span>
              ) : null}
            </div>
            {video.description ? (
              <Card>
                <CardContent className="p-4">
                  <p className="whitespace-pre-wrap text-sm text-foreground">
                    {video.description}
                  </p>
                </CardContent>
              </Card>
            ) : null}
          </div>
          <aside className="space-y-3">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Related in {labelForAppKey(video.app_key)}
            </h2>
            {related.length === 0 ? (
              <p className="text-sm text-muted-foreground">No related resources yet.</p>
            ) : (
              related.map((r) => (
                <Link
                  key={r.id}
                  to={`/resources/${r.id}`}
                  className="flex gap-3 rounded-md border border-transparent p-2 hover:border-border hover:bg-muted/50"
                >
                  <div className="relative aspect-video w-24 shrink-0 overflow-hidden rounded bg-muted">
                    {r.thumbnail_url ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.thumbnail_url} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full items-center justify-center">
                        <Play className="h-4 w-4 text-muted-foreground" />
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 text-sm font-medium">{r.title}</div>
                    {r.duration_seconds ? (
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {formatDuration(r.duration_seconds)}
                      </div>
                    ) : null}
                  </div>
                </Link>
              ))
            )}
          </aside>
        </div>
      </PageBody>
    </>
  );
}
