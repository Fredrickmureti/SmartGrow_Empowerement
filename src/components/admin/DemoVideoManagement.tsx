import { useState } from "react";
import { useDemoVideos, type DemoVideo, type CreateDemoVideoInput } from "@/hooks/useDemoVideos";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { 
  Loader2, 
  Video, 
  Plus, 
  ExternalLink, 
  Pencil, 
  Trash2,
  Eye,
  EyeOff,
  GripVertical,
  Play
} from "lucide-react";

const CATEGORIES = [
  { value: "general", label: "General" },
  { value: "tutorial", label: "Tutorial" },
  { value: "feature", label: "Feature Overview" },
  { value: "getting-started", label: "Getting Started" },
  { value: "advanced", label: "Advanced" },
];

export function DemoVideoManagement() {
  const { videos, isLoading, isSaving, createVideo, updateVideo, deleteVideo, togglePublish } = useDemoVideos();
  
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [editingVideo, setEditingVideo] = useState<DemoVideo | null>(null);
  const [videoToDelete, setVideoToDelete] = useState<DemoVideo | null>(null);
  
  // Form state
  const [formData, setFormData] = useState<CreateDemoVideoInput>({
    title: "",
    description: "",
    video_url: "",
    thumbnail_url: "",
    category: "general",
    is_published: false,
  });

  const resetForm = () => {
    setFormData({
      title: "",
      description: "",
      video_url: "",
      thumbnail_url: "",
      category: "general",
      is_published: false,
    });
    setEditingVideo(null);
  };

  const handleOpenDialog = (video?: DemoVideo) => {
    if (video) {
      setEditingVideo(video);
      setFormData({
        title: video.title,
        description: video.description || "",
        video_url: video.video_url,
        thumbnail_url: video.thumbnail_url || "",
        category: video.category,
        is_published: video.is_published,
      });
    } else {
      resetForm();
    }
    setDialogOpen(true);
  };

  const handleCloseDialog = () => {
    setDialogOpen(false);
    resetForm();
  };

  const handleSubmit = async () => {
    if (!formData.title || !formData.video_url) return;

    try {
      if (editingVideo) {
        await updateVideo(editingVideo.id, formData);
      } else {
        await createVideo(formData);
      }
      handleCloseDialog();
    } catch (error) {
      // Error handled in hook
    }
  };

  const handleDeleteConfirm = async () => {
    if (!videoToDelete) return;
    await deleteVideo(videoToDelete.id);
    setDeleteDialogOpen(false);
    setVideoToDelete(null);
  };

  const getEmbedUrl = (url: string): string | null => {
    // YouTube
    const youtubeMatch = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]+)/);
    if (youtubeMatch) {
      return `https://www.youtube.com/embed/${youtubeMatch[1]}?rel=0`;
    }

    // Vimeo
    const vimeoMatch = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
    if (vimeoMatch) {
      return `https://player.vimeo.com/video/${vimeoMatch[1]}`;
    }

    return null;
  };

  const getVideoThumbnail = (url: string): string | null => {
    const youtubeMatch = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]+)/);
    if (youtubeMatch) {
      return `https://img.youtube.com/vi/${youtubeMatch[1]}/mqdefault.jpg`;
    }
    return null;
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Video className="h-5 w-5" />
                Demo Video Library
              </CardTitle>
              <CardDescription className="mt-1">
                Manage demo and tutorial videos displayed on the public demo page
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" asChild>
                <a href="/demo" target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4 mr-1.5" />
                  <span className="hidden sm:inline">Preview Page</span>
                  <span className="sm:hidden">Preview</span>
                </a>
              </Button>
              <Button size="sm" onClick={() => handleOpenDialog()}>
                <Plus className="h-4 w-4 mr-1.5" />
                Add Video
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : videos.length === 0 ? (
            <div className="text-center py-12 border-2 border-dashed rounded-lg">
              <Video className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">No Demo Videos Yet</h3>
              <p className="text-muted-foreground mb-4">
                Add your first demo video to showcase your product
              </p>
              <Button onClick={() => handleOpenDialog()}>
                <Plus className="h-4 w-4 mr-2" />
                Add First Video
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {videos.map((video) => (
                <div
                  key={video.id}
                  className="flex flex-col sm:flex-row sm:items-start gap-3 p-3 sm:p-4 border rounded-lg hover:bg-muted/50 transition-colors"
                >
                  <div className="hidden sm:block cursor-grab text-muted-foreground pt-1">
                    <GripVertical className="h-5 w-5" />
                  </div>
                  
                  {/* Thumbnail */}
                  <div className="relative w-full sm:w-36 aspect-video rounded-md overflow-hidden bg-muted flex-shrink-0">
                    {video.thumbnail_url || getVideoThumbnail(video.video_url) ? (
                      <img
                        src={video.thumbnail_url || getVideoThumbnail(video.video_url) || ""}
                        alt={video.title}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Play className="h-8 w-8 text-muted-foreground" />
                      </div>
                    )}
                  </div>

                  {/* Video Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5 mb-1">
                      <h3 className="font-medium text-sm truncate max-w-[200px] sm:max-w-none">{video.title}</h3>
                      <Badge variant={video.is_published ? "default" : "secondary"} className="text-[10px] px-1.5 py-0">
                        {video.is_published ? "Published" : "Draft"}
                      </Badge>
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">{video.category}</Badge>
                    </div>
                    {video.description && (
                      <p className="text-xs sm:text-sm text-muted-foreground line-clamp-2 mb-1.5">
                        {video.description}
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground truncate">
                      {video.video_url}
                    </p>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 sm:gap-2 border-t sm:border-t-0 pt-2 sm:pt-0 mt-1 sm:mt-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => togglePublish(video.id)}
                      disabled={isSaving}
                      title={video.is_published ? "Unpublish" : "Publish"}
                    >
                      {video.is_published ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleOpenDialog(video)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => {
                        setVideoToDelete(video);
                        setDeleteDialogOpen(true);
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="w-[95vw] max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-base sm:text-lg">
              {editingVideo ? "Edit Demo Video" : "Add Demo Video"}
            </DialogTitle>
            <DialogDescription className="text-xs sm:text-sm">
              Add a YouTube, Vimeo, or direct video URL to display on the demo page
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2 sm:py-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="title">Title *</Label>
                <Input
                  id="title"
                  value={formData.title}
                  onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                  placeholder="Getting Started with AccrualFlow"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="category">Category</Label>
                <Select
                  value={formData.category}
                  onValueChange={(value) => setFormData({ ...formData, category: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((cat) => (
                      <SelectItem key={cat.value} value={cat.value}>
                        {cat.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="video_url">Video URL *</Label>
              <Input
                id="video_url"
                value={formData.video_url}
                onChange={(e) => setFormData({ ...formData, video_url: e.target.value })}
                placeholder="https://www.youtube.com/watch?v=... or https://vimeo.com/..."
              />
              <p className="text-xs text-muted-foreground">
                Supports YouTube, Vimeo, or direct video URLs (.mp4, .webm)
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={formData.description}
                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                placeholder="A brief description of what this video covers..."
                rows={3}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="thumbnail_url">Custom Thumbnail URL (optional)</Label>
              <Input
                id="thumbnail_url"
                value={formData.thumbnail_url}
                onChange={(e) => setFormData({ ...formData, thumbnail_url: e.target.value })}
                placeholder="https://example.com/thumbnail.jpg"
              />
              <p className="text-xs text-muted-foreground">
                Leave empty to auto-detect from YouTube/Vimeo
              </p>
            </div>

            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <Label>Publish immediately</Label>
                <p className="text-sm text-muted-foreground">
                  Make this video visible on the public demo page
                </p>
              </div>
              <Switch
                checked={formData.is_published}
                onCheckedChange={(checked) => setFormData({ ...formData, is_published: checked })}
              />
            </div>

            {/* Video Preview */}
            {formData.video_url && getEmbedUrl(formData.video_url) && (
              <div className="space-y-2">
                <Label>Preview</Label>
                <div className="aspect-video rounded-lg overflow-hidden border bg-muted">
                  <iframe
                    src={getEmbedUrl(formData.video_url) || ""}
                    title="Video Preview"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowFullScreen
                    className="w-full h-full"
                  />
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={handleCloseDialog}>
              Cancel
            </Button>
            <Button 
              onClick={handleSubmit} 
              disabled={isSaving || !formData.title || !formData.video_url}
            >
              {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {editingVideo ? "Save Changes" : "Add Video"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Demo Video</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{videoToDelete?.title}"? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
