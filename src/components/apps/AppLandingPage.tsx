/**
 * AppLandingPage Component
 * 
 * Marketing landing page shown when users first access an app.
 * Displays features, benefits, and "Start Now" CTA.
 */

import { useNavigate } from "react-router-dom";
import { ArrowRight, Check } from "lucide-react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { AppDefinition } from "@/lib/apps/types";
import { getAppContent } from "@/lib/apps/app-features";

interface AppLandingPageProps {
  app: AppDefinition;
  onActivate: () => void;
  isActivating?: boolean;
}

export function AppLandingPage({ app, onActivate, isActivating }: AppLandingPageProps) {
  const navigate = useNavigate();
  const content = getAppContent(app.id);

  return (
    <div className="min-h-screen bg-background">
      {/* Hero Section */}
      <section className="relative overflow-hidden">
        {/* Background gradient */}
        <div 
          className="absolute inset-0 opacity-10"
          style={{ 
            background: `radial-gradient(ellipse at top, ${app.color} 0%, transparent 70%)` 
          }}
        />
        
        <div className="relative max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-16 sm:py-24">
          <div className="text-center">
            {/* App Icon */}
            <motion.div
              initial={{ scale: 0.8, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.3 }}
              className="inline-flex items-center justify-center w-20 h-20 rounded-2xl mb-6"
              style={{ backgroundColor: `${app.color}20` }}
            >
              <app.icon className="w-10 h-10" style={{ color: app.color }} />
            </motion.div>

            {/* Tagline */}
            <motion.div
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ duration: 0.4, delay: 0.1 }}
            >
              <Badge variant="secondary" className="mb-4">
                {content.tagline}
              </Badge>
            </motion.div>

            {/* Headline */}
            <motion.h1
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ duration: 0.4, delay: 0.2 }}
              className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight text-foreground mb-6"
            >
              {content.headline}
            </motion.h1>

            {/* Description */}
            <motion.p
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ duration: 0.4, delay: 0.3 }}
              className="text-lg sm:text-xl text-muted-foreground max-w-2xl mx-auto mb-10"
            >
              {content.description}
            </motion.p>

            {/* CTAs — primary always routes through /apps/{appId}/activate
                so the user gets the proper Install / Start trial / Subscribe
                / Coming-soon flow with full dependency preflight, instead of
                a raw install bypass. */}
            <motion.div
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ duration: 0.4, delay: 0.4 }}
              className="flex flex-col sm:flex-row items-center justify-center gap-4"
            >
              <Button
                size="lg"
                onClick={() => navigate(`/apps/${app.id}/activate`)}
                disabled={isActivating}
                className="gap-2 text-lg px-8 py-6"
                style={{
                  backgroundColor: app.color,
                  color: 'white',
                }}
              >
                {isActivating ? "Activating..." : content.ctaText}
                <ArrowRight className="w-5 h-5" />
              </Button>

            </motion.div>
          </div>
        </div>
      </section>

      {/* Features Section */}
      {content.features.length > 0 && (
        <section className="py-16 sm:py-24 bg-muted/30">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-12">
              <h2 className="text-3xl font-bold text-foreground mb-4">
                Everything you need
              </h2>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                Powerful features designed to help you work smarter, not harder.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              {content.features.map((feature, index) => (
                <motion.div
                  key={feature.title}
                  initial={{ y: 30, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  transition={{ duration: 0.4, delay: 0.1 * index }}
                >
                  <Card className="h-full border-0 shadow-sm hover:shadow-md transition-shadow">
                    <CardContent className="p-6">
                      <div
                        className="inline-flex items-center justify-center w-12 h-12 rounded-lg mb-4"
                        style={{ backgroundColor: `${app.color}15` }}
                      >
                        <feature.icon
                          className="w-6 h-6"
                          style={{ color: app.color }}
                        />
                      </div>
                      <h3 className="text-lg font-semibold text-foreground mb-2">
                        {feature.title}
                      </h3>
                      <p className="text-sm text-muted-foreground">
                        {feature.description}
                      </p>
                    </CardContent>
                  </Card>
                </motion.div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Benefits Section */}
      {content.benefits.length > 0 && (
        <section className="py-16 sm:py-24">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-12">
              <h2 className="text-3xl font-bold text-foreground mb-4">
                Why choose {app.name}?
              </h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {content.benefits.map((benefit, index) => (
                <motion.div
                  key={benefit.text}
                  initial={{ x: -20, opacity: 0 }}
                  animate={{ x: 0, opacity: 1 }}
                  transition={{ duration: 0.3, delay: 0.1 * index }}
                  className="flex items-center gap-3 p-4 rounded-lg bg-muted/50"
                >
                  <div
                    className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center"
                    style={{ backgroundColor: `${app.color}20` }}
                  >
                    <Check className="w-4 h-4" style={{ color: app.color }} />
                  </div>
                  <span className="text-foreground font-medium">
                    {benefit.text}
                  </span>
                </motion.div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* Final CTA Section */}
      <section 
        className="py-16 sm:py-24"
        style={{ backgroundColor: `${app.color}08` }}
      >
        <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
          <h2 className="text-3xl font-bold text-foreground mb-4">
            Ready to get started?
          </h2>
          <p className="text-lg text-muted-foreground mb-8">
            Start using {app.name} today. No credit card required.
          </p>
          <Button
            size="lg"
            onClick={() => navigate(`/apps/${app.id}/activate`)}
            disabled={isActivating}
            className="gap-2 text-lg px-8 py-6"
            style={{
              backgroundColor: app.color,
              color: 'white',
            }}
          >
            {isActivating ? "Activating..." : content.ctaText}
            <ArrowRight className="w-5 h-5" />
          </Button>
        </div>
      </section>
    </div>
  );
}
