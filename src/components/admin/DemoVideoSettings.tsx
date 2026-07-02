import { useState, useEffect } from "react";
import { usePlatformSettings } from "@/hooks/usePlatformSettings";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Loader2, Video, ExternalLink, Play } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export function DemoVideoSettings() {
  const { toast } = useToast();
  const { settings, isLoading, isSaving, getSetting, updateMultipleSettings } = usePlatformSettings();
  
  const [videoUrl, setVideoUrl] = useState("");
  const [videoTitle, setVideoTitle] = useState("");
  const [videoDescription, setVideoDescription] = useState("");

  useEffect(() => {
    if (settings.length > 0) {
      setVideoUrl(getSetting("demo_video_url") || "");
      setVideoTitle(getSetting("demo_video_title") || "");
      setVideoDescription(getSetting("demo_video_description") || "");
    }
  }, [settings, getSetting]);

  const handleSave = async () => {
    await updateMultipleSettings([
      { key: "demo_video_url", value: videoUrl || null },
      { key: "demo_video_title", value: videoTitle || "See AccrualFlow in Action" },
      { key: "demo_video_description", value: videoDescription || null },
    ]);
    toast({
      title: "Demo video settings saved",
      description: "The demo page will now display your configured video.",
    });
  };

  // Convert YouTube/Vimeo URLs to embed URLs for preview
  const getEmbedUrl = (url: string): string | null => {
    if (!url) return null;
    
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

  const embedUrl = getEmbedUrl(videoUrl);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Video className="h-5 w-5" />
            Demo Video Configuration
          </CardTitle>
          <CardDescription>
            Configure the tutorial/demo video shown on the public demo page
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="video-url">Video URL</Label>
                <Input
                  id="video-url"
                  placeholder="https://www.youtube.com/watch?v=... or https://vimeo.com/..."
                  value={videoUrl}
                  onChange={(e) => setVideoUrl(e.target.value)}
                />
                <p className="text-sm text-muted-foreground">
                  Supports YouTube, Vimeo, or direct video URLs (.mp4, .webm)
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="video-title">Page Title</Label>
                <Input
                  id="video-title"
                  placeholder="See AccrualFlow in Action"
                  value={videoTitle}
                  onChange={(e) => setVideoTitle(e.target.value)}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="video-description">Page Description</Label>
                <Textarea
                  id="video-description"
                  placeholder="Watch our comprehensive product demo..."
                  value={videoDescription}
                  onChange={(e) => setVideoDescription(e.target.value)}
                  rows={3}
                />
              </div>

              <div className="flex items-center gap-3">
                <Button onClick={handleSave} disabled={isSaving}>
                  {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Save Changes
                </Button>
                <Button variant="outline" asChild>
                  <a href="/demo" target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-4 w-4 mr-2" />
                    Preview Demo Page
                  </a>
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Video Preview */}
      {embedUrl && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Play className="h-5 w-5" />
              Video Preview
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="aspect-video rounded-lg overflow-hidden border bg-muted">
              <iframe
                src={embedUrl}
                title="Demo Video Preview"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
                className="w-full h-full"
              />
            </div>
          </CardContent>
        </Card>
      )}

      {videoUrl && !embedUrl && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Play className="h-5 w-5" />
              Video Preview
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="aspect-video rounded-lg overflow-hidden border bg-muted">
              <video
                src={videoUrl}
                controls
                className="w-full h-full object-cover"
              >
                Your browser does not support the video tag.
              </video>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
