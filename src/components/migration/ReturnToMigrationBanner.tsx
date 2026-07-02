import { useSearchParams, useNavigate } from "react-router-dom";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

export function ReturnToMigrationBanner() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const returnTo = searchParams.get("returnTo");

  if (!returnTo || !returnTo.startsWith("/")) return null;

  return (
    <Alert className="mb-4 border-primary/30 bg-primary/5">
      <ArrowLeft className="h-4 w-4" />
      <AlertDescription className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-sm">You were configuring data migration.</span>
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate(returnTo)}
          className="shrink-0"
        >
          <ArrowLeft className="h-3.5 w-3.5 mr-1" />
          Return to Migration
        </Button>
      </AlertDescription>
    </Alert>
  );
}
