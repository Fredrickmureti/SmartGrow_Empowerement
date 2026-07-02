import { useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { LandingHeader } from "@/components/landing/LandingHeader";
import { FooterSection } from "@/components/landing/CTASection";
import { ScheduleDemoDialog } from "@/components/landing/ScheduleDemoDialog";
import { useDemoVideos, type DemoVideo } from "@/hooks/useDemoVideos";
import { Play, Calendar, ArrowRight, Video, ChevronLeft, ChevronRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function Demo() {
  const { videos, isLoading } = useDemoVideos(true); // Only published videos
  const [showScheduleDialog, setShowScheduleDialog] = useState(false);
  const [selectedVideo, setSelectedVideo] = useState<DemoVideo | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string>("all");

  // Set first video as selected once loaded
  const filteredVideos = videos.filter(
    v => selectedCategory === "all" || v.category === selectedCategory
  );
  
  const currentVideo = selectedVideo || filteredVideos[0];

  // Get unique categories
  const categories = ["all", ...Array.from(new Set(videos.map(v => v.category)))];

  // Convert YouTube/Vimeo URLs to embed URLs
  const getEmbedUrl = (url: string): string => {
    const youtubeMatch = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]+)/);
    if (youtubeMatch) {
      return `https://www.youtube.com/embed/${youtubeMatch[1]}?rel=0`;
    }

    const vimeoMatch = url.match(/vimeo\.com\/(?:video\/)?(\d+)/);
    if (vimeoMatch) {
      return `https://player.vimeo.com/video/${vimeoMatch[1]}`;
    }

    return url;
  };

  const isDirectVideo = (url: string): boolean => {
    return /\.(mp4|webm|ogg)$/i.test(url);
  };

  const getVideoThumbnail = (url: string): string | null => {
    const youtubeMatch = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/)|youtu\.be\/)([a-zA-Z0-9_-]+)/);
    if (youtubeMatch) {
      return `https://img.youtube.com/vi/${youtubeMatch[1]}/mqdefault.jpg`;
    }
    return null;
  };

  const formatCategory = (cat: string) => {
    return cat.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  };

  return (
    <div className="min-h-screen bg-background">
      <LandingHeader />
      
      <main className="pt-24 pb-16">
        <div className="container mx-auto px-4">
          {/* Hero Section */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
            className="text-center mb-12"
          >
            <div className="inline-flex items-center gap-2 bg-primary/10 text-primary px-4 py-2 rounded-full text-sm font-medium mb-6">
              <Video className="h-4 w-4" />
              Product Demo
            </div>
            
            {isLoading ? (
              <>
                <Skeleton className="h-12 w-96 mx-auto mb-4" />
                <Skeleton className="h-6 w-[500px] mx-auto" />
              </>
            ) : (
              <>
                <h1 className="text-4xl md:text-5xl font-bold mb-4">
                  See AccrualFlow in Action
                </h1>
                <p className="text-xl text-muted-foreground max-w-2xl mx-auto">
                  {videos.length > 0 
                    ? "Watch our tutorials and feature demonstrations to learn how AccrualFlow can transform your business."
                    : "We're preparing demo content. Schedule a personalized walkthrough with our team."}
                </p>
              </>
            )}
          </motion.div>

          {/* Video Section */}
          {isLoading ? (
            <div className="max-w-5xl mx-auto mb-16">
              <Skeleton className="aspect-video w-full rounded-xl" />
            </div>
          ) : videos.length > 0 ? (
            <>
              {/* Category Tabs */}
              {categories.length > 2 && (
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: 0.1 }}
                  className="flex justify-center mb-8"
                >
                  <Tabs value={selectedCategory} onValueChange={setSelectedCategory}>
                    <TabsList>
                      {categories.map((cat) => (
                        <TabsTrigger key={cat} value={cat}>
                          {cat === "all" ? "All Videos" : formatCategory(cat)}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  </Tabs>
                </motion.div>
              )}

              {/* Main Video Player */}
              <motion.div
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.2 }}
                className="max-w-5xl mx-auto mb-8"
              >
                {currentVideo && (
                  <div className="space-y-4">
                    <div className="relative aspect-video rounded-xl overflow-hidden shadow-2xl border bg-muted">
                      {isDirectVideo(currentVideo.video_url) ? (
                        <video
                          key={currentVideo.id}
                          src={currentVideo.video_url}
                          controls
                          className="w-full h-full object-cover"
                          poster={currentVideo.thumbnail_url || undefined}
                        >
                          Your browser does not support the video tag.
                        </video>
                      ) : (
                        <iframe
                          key={currentVideo.id}
                          src={getEmbedUrl(currentVideo.video_url)}
                          title={currentVideo.title}
                          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                          allowFullScreen
                          className="w-full h-full"
                        />
                      )}
                    </div>
                    <div className="flex items-start justify-between">
                      <div>
                        <h2 className="text-2xl font-semibold">{currentVideo.title}</h2>
                        {currentVideo.description && (
                          <p className="text-muted-foreground mt-1">{currentVideo.description}</p>
                        )}
                      </div>
                      <Badge variant="secondary">{formatCategory(currentVideo.category)}</Badge>
                    </div>
                  </div>
                )}
              </motion.div>

              {/* Video Gallery */}
              {filteredVideos.length > 1 && (
                <motion.div
                  initial={{ opacity: 0, y: 30 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: 0.3 }}
                  className="max-w-5xl mx-auto mb-16"
                >
                  <h3 className="text-lg font-medium mb-4">More Videos</h3>
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                    {filteredVideos.map((video) => (
                      <button
                        key={video.id}
                        onClick={() => setSelectedVideo(video)}
                        className={`group relative aspect-video rounded-lg overflow-hidden border transition-all ${
                          currentVideo?.id === video.id 
                            ? "ring-2 ring-primary" 
                            : "hover:ring-2 hover:ring-primary/50"
                        }`}
                      >
                        {video.thumbnail_url || getVideoThumbnail(video.video_url) ? (
                          <img
                            src={video.thumbnail_url || getVideoThumbnail(video.video_url) || ""}
                            alt={video.title}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <div className="w-full h-full bg-muted flex items-center justify-center">
                            <Play className="h-8 w-8 text-muted-foreground" />
                          </div>
                        )}
                        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                          <Play className="h-10 w-10 text-white" />
                        </div>
                        <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/80 to-transparent">
                          <p className="text-white text-sm font-medium truncate">{video.title}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                </motion.div>
              )}

              {/* CTA Section */}
              <motion.div
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.4 }}
                className="text-center"
              >
                <div className="inline-flex flex-col sm:flex-row items-center gap-4 p-6 rounded-2xl bg-muted/50 border">
                  <div className="text-left">
                    <h3 className="font-semibold text-lg">Ready for a personalized walkthrough?</h3>
                    <p className="text-muted-foreground">
                      Schedule a live demo tailored to your business needs.
                    </p>
                  </div>
                  <div className="flex gap-3">
                    <Button variant="outline" asChild>
                      <Link to="/signup">
                        Start Free Trial
                        <ArrowRight className="ml-2 h-4 w-4" />
                      </Link>
                    </Button>
                    <Button onClick={() => setShowScheduleDialog(true)}>
                      <Calendar className="mr-2 h-4 w-4" />
                      Schedule Demo
                    </Button>
                  </div>
                </div>
              </motion.div>
            </>
          ) : (
            // No Videos - Coming Soon State
            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="max-w-4xl mx-auto mb-16"
            >
              <div className="aspect-video rounded-xl border-2 border-dashed border-muted-foreground/20 bg-muted/50 flex flex-col items-center justify-center">
                <div className="h-20 w-20 rounded-full bg-primary/10 flex items-center justify-center mb-6">
                  <Play className="h-10 w-10 text-primary" />
                </div>
                <h3 className="text-2xl font-semibold mb-2">Demo Videos Coming Soon</h3>
                <p className="text-muted-foreground mb-6 max-w-md text-center px-4">
                  We're preparing comprehensive tutorials and feature demonstrations. 
                  In the meantime, schedule a personalized demo with our team to see AccrualFlow in action.
                </p>
                <div className="flex gap-3">
                  <Button variant="outline" asChild>
                    <Link to="/signup">
                      Start Free Trial
                      <ArrowRight className="ml-2 h-4 w-4" />
                    </Link>
                  </Button>
                  <Button onClick={() => setShowScheduleDialog(true)} size="lg">
                    <Calendar className="mr-2 h-5 w-5" />
                    Schedule a Live Demo
                  </Button>
                </div>
              </div>
            </motion.div>
          )}
        </div>
      </main>

      <FooterSection />

      <ScheduleDemoDialog
        open={showScheduleDialog}
        onOpenChange={setShowScheduleDialog}
      />
    </div>
  );
}
