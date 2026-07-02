/**
 * AppUnderDevelopment — landing page for "coming soon" apps.
 *
 * Replaces the old blurred tile + "Notify Me" pattern with a real,
 * informative surface that:
 *   - shows the app icon, name, and roadmap
 *   - has explicit copy ("we'll email you the day it ships, no charge")
 *   - writes to app_launch_notifications via useAppLaunchNotification
 *   - links the user to a sensible alternative (e.g. Recruitment → Employees)
 */
import { motion } from "framer-motion";
import { ArrowLeft, ArrowRight, Bell, BellRing, Hammer, MapPin } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAppLaunchNotification } from "@/hooks/useAppLaunchNotification";
import type { AppDefinition } from "@/lib/apps/types";

interface RoadmapItem {
  title: string;
  description: string;
}

interface AppUnderDevelopmentProps {
  app: AppDefinition;
  /** Short paragraph describing what this app will do */
  pitch: string;
  /** Optional planned-features list */
  roadmap?: RoadmapItem[];
  /** Optional ETA string (e.g. "Q2 2026"); omit when unknown */
  eta?: string;
  /** Optional related-app link (e.g. Recruitment → Employees) */
  relatedAction?: { label: string; description: string; to: string };
}

export function AppUnderDevelopment({
  app,
  pitch,
  roadmap = [],
  eta,
  relatedAction,
}: AppUnderDevelopmentProps) {
  const navigate = useNavigate();
  const Icon = app.icon;
  const { alreadyNotified, notifyMe, isSubmitting } =
    useAppLaunchNotification(app.id);

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <Button variant="ghost" size="sm" onClick={() => navigate("/apps")}>
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Apps
          </Button>
          <Badge variant="secondary" className="gap-1.5">
            <Hammer className="h-3.5 w-3.5" />
            Under development
          </Badge>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div
          className="absolute inset-0 opacity-10"
          style={{
            background: `radial-gradient(ellipse at top, ${app.color} 0%, transparent 70%)`,
          }}
        />
        <div className="relative max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-16 sm:py-20 text-center">
          <motion.div
            initial={{ scale: 0.85, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.3 }}
            className="inline-flex items-center justify-center w-20 h-20 rounded-2xl mb-6"
            style={{ backgroundColor: `${app.color}20` }}
          >
            <Icon className="w-10 h-10" style={{ color: app.color }} />
          </motion.div>

          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">
            {app.name} is on the way
          </h1>
          <p className="mt-4 text-base sm:text-lg text-muted-foreground max-w-2xl mx-auto">
            {pitch}
          </p>

          {eta && (
            <div className="mt-5 inline-flex items-center gap-2 text-sm text-muted-foreground">
              <MapPin className="h-4 w-4" />
              Targeted release: <span className="font-medium text-foreground">{eta}</span>
            </div>
          )}

          {/* Notify-me */}
          <motion.div
            initial={{ y: 16, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ duration: 0.3, delay: 0.15 }}
            className="mt-8 flex flex-col items-center gap-2"
          >
            {alreadyNotified ? (
              <Button variant="outline" size="lg" disabled className="gap-2">
                <BellRing className="h-4 w-4" />
                You're on the launch list
              </Button>
            ) : (
              <Button
                size="lg"
                disabled={isSubmitting}
                onClick={() => void notifyMe()}
                className="gap-2"
                style={{ backgroundColor: app.color, color: "white" }}
              >
                <Bell className="h-4 w-4" />
                {isSubmitting ? "Saving..." : "Notify me when it ships"}
              </Button>
            )}
            <p className="text-xs text-muted-foreground max-w-sm">
              We'll email you the day {app.name} is available. No charge, no
              commitment — you choose whether to install it then.
            </p>
          </motion.div>
        </div>
      </section>

      {/* Roadmap */}
      {roadmap.length > 0 && (
        <section className="py-12 sm:py-16 bg-muted/30">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
            <h2 className="text-xl font-semibold mb-6 text-center">
              What's planned
            </h2>
            <div className="grid gap-4 sm:grid-cols-2">
              {roadmap.map((item) => (
                <Card key={item.title}>
                  <CardHeader className="space-y-1.5">
                    <CardTitle className="text-base">{item.title}</CardTitle>
                    <CardDescription>{item.description}</CardDescription>
                  </CardHeader>
                </Card>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Related action */}
      {relatedAction && (
        <section className="py-10">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
            <Card className="bg-muted/40">
              <CardContent className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 py-5">
                <div className="space-y-1">
                  <p className="font-medium">{relatedAction.label}</p>
                  <p className="text-sm text-muted-foreground">
                    {relatedAction.description}
                  </p>
                </div>
                <Button asChild variant="outline">
                  <Link to={relatedAction.to}>
                    Continue
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Link>
                </Button>
              </CardContent>
            </Card>
          </div>
        </section>
      )}
    </div>
  );
}
