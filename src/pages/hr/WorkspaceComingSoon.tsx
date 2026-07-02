/**
 * Shared placeholder for Wave-1 HR sub-app surfaces that exist in the
 * navigation but have not yet been built out (e.g. /hr/contracts/drafts,
 * /hr/lifecycle/probation, individual report questions).
 *
 * Keeps the workspace shell honest: the nav reflects the final IA, and
 * unbuilt surfaces render a consistent, clearly labelled stub instead of
 * a blank page or a 404.
 */

import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Construction } from "lucide-react";

interface WorkspaceComingSoonProps {
  title: string;
  description?: string;
  context?: string;
}

export function WorkspaceComingSoon({ title, description, context }: WorkspaceComingSoonProps) {
  return (
    <div className="p-6">
      <Card className="max-w-2xl">
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="rounded-md bg-muted p-2">
              <Construction className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <CardTitle>{title}</CardTitle>
              {context ? (
                <CardDescription className="mt-1">{context}</CardDescription>
              ) : null}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {description ??
              "This workspace surface is scaffolded as part of the HR domain Wave-1 evolution. The data layer (tables, RPCs, views) is in place; the UI ships in a subsequent turn."}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export default WorkspaceComingSoon;