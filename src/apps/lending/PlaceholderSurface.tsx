/**
 * Lending placeholder surface.
 *
 * C1 scaffold: every lending route resolves to a real page inside the shell
 * so navigation is verifiable before the domain milestones land. Each surface
 * names the milestone that replaces it.
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface PlaceholderSurfaceProps {
  title: string;
  description: string;
  milestone: string;
}

export function PlaceholderSurface({ title, description, milestone }: PlaceholderSurfaceProps) {
  return (
    <div className="p-6">
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            This surface is scaffolded and will be implemented in {milestone}.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export default PlaceholderSurface;
