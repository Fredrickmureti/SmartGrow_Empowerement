/**
 * DemoVideoManagement — demo-video library list surface. Create/edit
 * routes to dedicated workspace pages under
 * `/admin-management/settings/demo-videos/*` per the Platform Admin
 * four-pattern rule. Delete stays as a confirm dialog.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useDemoVideos, type DemoVideo } from "@/hooks/useDemoVideos";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  Play,
} from "lucide-react";

export function DemoVideoManagement() {
  const navigate = useNavigate();
  const { videos, isLoading, isSaving, deleteVideo, togglePublish } =
    useDemoVideos();
  const [videoToDelete, setVideoToDelete] = useState<DemoVideo | null>(null);

  const handleDeleteConfirm = async () => {
    if (!videoToDelete) return;
    await deleteVideo(videoToDelete.id);
    setVideoToDelete(null);
  };

  const getVideoThumbnail = (url: string): string | null => {
    const youtubeMatch = url.match(
      /(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]+)/,
    );
    if (youtubeMatch) return `https://img.youtube.com/vi/${youtubeMatch[1]}/mqdefault.jpg`;
    return null;
  };

  const basePath = "/admin-management/settings/demo-videos";

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
              <Button size="sm" onClick={() => navigate(`${basePath}/new`)}>
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
              <Button onClick={() => navigate(`${basePath}/new`)}>
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

                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5 mb-1">
                      <h3 className="font-medium text-sm truncate max-w-[200px] sm:max-w-none">
                        {video.title}
                      </h3>
                      <Badge
                        variant={video.is_published ? "default" : "secondary"}
                        className="text-[10px] px-1.5 py-0"
                      >
                        {video.is_published ? "Published" : "Draft"}
                      </Badge>
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                        {video.category}
                      </Badge>
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
                      onClick={() => navigate(`${basePath}/${video.id}/edit`)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => setVideoToDelete(video)}
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

      <AlertDialog
        open={!!videoToDelete}
        onOpenChange={(o) => { if (!o) setVideoToDelete(null); }}
      >
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
