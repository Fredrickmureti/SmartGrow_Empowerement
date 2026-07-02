/**
 * DocumentPeekShell — the standardized DetailSheet wrapper every Sales
 * list uses for its `?peek=<id>` peek surface. Owns the header layout,
 * "Open full page" affordance, footer close/open bar, and the
 * loading/error/empty presentation. Per-entity peek sheets only supply
 * (a) the title/subtitle, (b) the section body when the record is ready.
 *
 * Keeps every Sales peek behaviorally identical (docs/design-system/audit/sales.md).
 */
import { type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowUpRight } from "lucide-react";

import {
  ActionBar,
  DetailSheet,
  ErrorState,
  FooterActionBar,
  LoadingState,
} from "@/design-system";
import { Button } from "@/components/ui/button";

interface DocumentPeekShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Route to the full record page. When set, header + footer expose "Open full page". */
  fullPageHref?: string;
  loading?: boolean;
  error?: string | null;
  errorTitle?: string;
  /** Rendered when !loading && !error && the record hook has resolved. */
  children?: ReactNode;
  /** Optional extra header actions rendered next to "Open full page". */
  extraHeaderActions?: ReactNode;
}

export function DocumentPeekShell({
  open,
  onOpenChange,
  title,
  description,
  fullPageHref,
  loading,
  error,
  errorTitle = "Unable to load record",
  children,
  extraHeaderActions,
}: DocumentPeekShellProps) {
  const navigate = useNavigate();
  const openFull = () => {
    if (!fullPageHref) return;
    onOpenChange(false);
    navigate(fullPageHref);
  };

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={title}
      description={description}
      headerActions={
        <>
          {extraHeaderActions}
          {fullPageHref && (
            <Button size="sm" variant="outline" onClick={openFull}>
              <ArrowUpRight className="mr-1.5 h-4 w-4" /> Open full page
            </Button>
          )}
        </>
      }
      footer={
        <FooterActionBar
          anchor="sheet"
          trailing={
            <ActionBar>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              {fullPageHref && <Button onClick={openFull}>Open full page</Button>}
            </ActionBar>
          }
        />
      }
    >
      {loading && <LoadingState />}
      {!loading && error && <ErrorState title={errorTitle} description={error} />}
      {!loading && !error && children}
    </DetailSheet>
  );
}
