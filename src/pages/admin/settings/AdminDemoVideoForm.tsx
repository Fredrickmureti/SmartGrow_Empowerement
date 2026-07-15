/**
 * AdminDemoVideoForm — routed create/edit surface for platform demo
 * videos, replacing the legacy inline dialog previously mounted from
 * `src/components/admin/DemoVideoManagement.tsx`.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  AdminRecordForm,
  AdminFieldGrid,
  AdminFieldCell,
} from "@/apps/platform-admin";
import { Section, LoadingState } from "@/design-system";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useDemoVideos,
  type CreateDemoVideoInput,
  type DemoVideo,
} from "@/hooks/useDemoVideos";
import {
  RESOURCE_APP_OPTIONS,
  DIFFICULTY_OPTIONS,
  AUDIENCE_OPTIONS,
} from "@/features/resources/appOptions";

const CATEGORIES: Array<{ value: string; label: string }> = [
  { value: "general", label: "General" },
  { value: "tutorial", label: "Tutorial" },
  { value: "feature", label: "Feature Overview" },
  { value: "getting-started", label: "Getting Started" },
  { value: "advanced", label: "Advanced" },
];

const LIST_PATH = "/admin-management/settings?tab=demo-videos";

function getEmbedUrl(url: string): string | null {
  const youtubeMatch = url.match(
    /(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]+)/,
  );
  if (youtubeMatch) return `https://www.youtube.com/embed/${youtubeMatch[1]}?rel=0`;
  const vimeoMatch = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
  if (vimeoMatch) return `https://player.vimeo.com/video/${vimeoMatch[1]}`;
  return null;
}

interface AdminDemoVideoFormProps {
  mode: "create" | "edit";
}

export function AdminDemoVideoForm({ mode }: AdminDemoVideoFormProps) {
  const navigate = useNavigate();
  const { id } = useParams<{ id: string }>();
  const { videos, isLoading, isSaving, createVideo, updateVideo } =
    useDemoVideos();

  const existing: DemoVideo | undefined =
    mode === "edit" ? videos.find((v) => v.id === id) : undefined;

  const [formData, setFormData] = useState<CreateDemoVideoInput>({
    title: "",
    description: "",
    video_url: "",
    thumbnail_url: "",
    category: "general",
    is_published: false,
    app_key: null,
    audience: "public",
    difficulty: null,
  });

  useEffect(() => {
    if (mode !== "edit" || !existing) return;
    setFormData({
      title: existing.title,
      description: existing.description ?? "",
      video_url: existing.video_url,
      thumbnail_url: existing.thumbnail_url ?? "",
      category: existing.category,
      is_published: existing.is_published,
      app_key: existing.app_key ?? null,
      audience: existing.audience ?? "public",
      difficulty: existing.difficulty ?? null,
    });
  }, [mode, existing]);

  if (mode === "edit" && isLoading) return <LoadingState />;

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!formData.title || !formData.video_url) return;
    try {
      if (mode === "edit" && existing) {
        await updateVideo(existing.id, formData);
      } else {
        await createVideo(formData);
      }
      navigate(LIST_PATH);
    } catch {
      // toast surfaced from hook
    }
  };

  const preview = formData.video_url ? getEmbedUrl(formData.video_url) : null;

  return (
    <AdminRecordForm
      mode={mode}
      entityLabel="Demo video"
      recordRef={mode === "edit" ? existing?.title : undefined}
      meta="Add a YouTube, Vimeo, or direct video URL to display on the public demo page."
      cancelHref={LIST_PATH}
      onSubmit={handleSubmit}
      isSubmitting={isSaving}
      submitDisabled={!formData.title || !formData.video_url}
      submitLabel={mode === "edit" ? "Save changes" : "Add video"}
    >
      <Section
        title="Details"
        description="Metadata shown alongside the video on the demo page."
      >
        <AdminFieldGrid columns={2}>
          <div className="space-y-2">
            <Label htmlFor="video-title">Title *</Label>
            <Input
              id="video-title"
              value={formData.title}
              onChange={(e) =>
                setFormData((p) => ({ ...p, title: e.target.value }))
              }
              placeholder="Getting Started with AccrualFlow"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="video-category">Category</Label>
            <Select
              value={formData.category}
              onValueChange={(v) =>
                setFormData((p) => ({ ...p, category: v }))
              }
            >
              <SelectTrigger id="video-category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="video-app">Product area</Label>
            <Select
              value={formData.app_key ?? "__none"}
              onValueChange={(v) =>
                setFormData((p) => ({ ...p, app_key: v === "__none" ? null : v }))
              }
            >
              <SelectTrigger id="video-app">
                <SelectValue placeholder="General / platform-wide" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">General / platform-wide</SelectItem>
                {RESOURCE_APP_OPTIONS.map((o) => (
                  <SelectItem key={o.key} value={o.key}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Which app this tutorial belongs to. Drives contextual surfacing inside the app.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="video-audience">Audience</Label>
            <Select
              value={formData.audience ?? "public"}
              onValueChange={(v) =>
                setFormData((p) => ({ ...p, audience: v as "public" | "authenticated" }))
              }
            >
              <SelectTrigger id="video-audience">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUDIENCE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="video-difficulty">Difficulty</Label>
            <Select
              value={formData.difficulty ?? "__none"}
              onValueChange={(v) =>
                setFormData((p) => ({ ...p, difficulty: v === "__none" ? null : (v as "intro" | "deep-dive") }))
              }
            >
              <SelectTrigger id="video-difficulty">
                <SelectValue placeholder="Unspecified" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none">Unspecified</SelectItem>
                {DIFFICULTY_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <AdminFieldCell span={2}>
            <div className="space-y-2">
              <Label htmlFor="video-url">Video URL *</Label>
              <Input
                id="video-url"
                value={formData.video_url}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, video_url: e.target.value }))
                }
                placeholder="https://www.youtube.com/watch?v=... or https://vimeo.com/..."
                required
              />
              <p className="text-xs text-muted-foreground">
                Supports YouTube, Vimeo, or direct video URLs (.mp4, .webm)
              </p>
            </div>
          </AdminFieldCell>
          <AdminFieldCell span={2}>
            <div className="space-y-2">
              <Label htmlFor="video-desc">Description</Label>
              <Textarea
                id="video-desc"
                value={formData.description}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, description: e.target.value }))
                }
                rows={3}
                placeholder="A brief description of what this video covers..."
              />
            </div>
          </AdminFieldCell>
          <AdminFieldCell span={2}>
            <div className="space-y-2">
              <Label htmlFor="video-thumb">Custom thumbnail URL</Label>
              <Input
                id="video-thumb"
                value={formData.thumbnail_url}
                onChange={(e) =>
                  setFormData((p) => ({ ...p, thumbnail_url: e.target.value }))
                }
                placeholder="Leave empty to auto-detect from YouTube/Vimeo"
              />
            </div>
          </AdminFieldCell>
        </AdminFieldGrid>
      </Section>

      <Section
        title="Publishing"
        description="Control whether this video is visible on the public demo page."
      >
        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="space-y-0.5">
            <Label>Publish immediately</Label>
            <p className="text-sm text-muted-foreground">
              When on, this video appears on <code>/demo</code> as soon as the
              form is saved.
            </p>
          </div>
          <Switch
            checked={!!formData.is_published}
            onCheckedChange={(checked) =>
              setFormData((p) => ({ ...p, is_published: checked }))
            }
          />
        </div>
      </Section>

      {preview && (
        <Section
          title="Preview"
          description="Verify the embed resolves before saving."
        >
          <div className="aspect-video overflow-hidden rounded-lg border bg-muted">
            <iframe
              src={preview}
              title="Video preview"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowFullScreen
              className="h-full w-full"
            />
          </div>
        </Section>
      )}
    </AdminRecordForm>
  );
}

export default AdminDemoVideoForm;
