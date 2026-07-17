/**
 * Mobile warehouse layout — top bar, scrollable body, no sidebar.
 * Locked to portrait CSS width; used by every /wm/* route.
 */
import { ReactNode, useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowLeft, Home } from "lucide-react";
import { Button } from "@/components/ui/button";
import { QueueIndicator } from "./QueueIndicator";
import { startDrainLoop } from "./offlineQueue";

interface Props {
  title: string;
  back?: string;
  children: ReactNode;
  bottomBar?: ReactNode;
}

export function MobileWarehouseLayout({ title, back, children, bottomBar }: Props) {
  const nav = useNavigate();
  useEffect(() => {
    startDrainLoop();
  }, []);
  return (
    <div className="fixed inset-0 flex flex-col bg-background text-foreground">
      <header className="flex items-center justify-between border-b px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          {back ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => nav(back)}
              className="h-9 w-9 p-0"
              aria-label="Back"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
          ) : (
            <Button size="sm" variant="ghost" asChild className="h-9 w-9 p-0" aria-label="Home">
              <Link to="/wm"><Home className="h-5 w-5" /></Link>
            </Button>
          )}
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">warehouse</div>
            <div className="font-semibold truncate">{title}</div>
          </div>
        </div>
        <QueueIndicator />
      </header>
      <main className="flex-1 overflow-y-auto p-3">{children}</main>
      {bottomBar && (
        <div className="border-t bg-background p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          {bottomBar}
        </div>
      )}
    </div>
  );
}
