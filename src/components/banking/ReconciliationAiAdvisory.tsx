/**
 * ReconciliationAiAdvisory — the assistant's opinion, clearly labelled as one.
 *
 * Two surfaces, one principle: the assistant is shown as *commentary beside*
 * the decision, never as the decision. It renders no button that changes the
 * books, it never reorders the operator's list on its own, and it says out loud
 * when it is unavailable so nobody mistakes silence for agreement.
 */
import { useState } from "react";
import { Sparkles, AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AdvisoryRateLimitedError,
  useCandidateAdvisory,
  useHistoryNarrative,
} from "@/hooks/useReconciliationAssistant";

const CONFIDENCE_COPY: Record<string, { label: string; variant: "default" | "secondary" | "outline" }> = {
  high: { label: "Well corroborated", variant: "default" },
  medium: { label: "Partly corroborated", variant: "secondary" },
  low: { label: "Weak evidence", variant: "outline" },
};

function AskButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <Button variant="outline" size="sm" onClick={onClick} className="gap-2">
      <Sparkles className="h-3.5 w-3.5" />
      {label}
    </Button>
  );
}

/** A throttle is not a breakage: say what happened and what still works. */
function ThrottleNotice({ error }: { error: unknown }) {
  if (!(error instanceof AdvisoryRateLimitedError)) return null;
  const minutes = Math.ceil(error.retryAfterSeconds / 60);
  return (
    <p className="text-xs text-muted-foreground">
      {error.message} Try again in about {minutes} minute{minutes === 1 ? "" : "s"} — the engine's
      own candidates and the recorded history are unchanged.
    </p>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border bg-muted/30 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Sparkles className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground">
          Assistant — advisory only, no action taken
        </span>
      </div>
      {children}
    </div>
  );
}

/**
 * Advice on which candidate deserves the first look. The candidate list itself
 * is produced by the database and is NOT re-ordered here; this only comments.
 */
export function CandidateAdvisoryPanel({ bankTransactionId }: { bankTransactionId?: string }) {
  const [asked, setAsked] = useState(false);
  const { data, isLoading, error } = useCandidateAdvisory(bankTransactionId, asked);

  if (!bankTransactionId) return null;

  if (!asked) {
    return <AskButton onClick={() => setAsked(true)} label="Ask the assistant which to check first" />;
  }

  if (isLoading) {
    return (
      <Frame>
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Reading the evidence…
        </p>
      </Frame>
    );
  }

  if (error) {
    return (
      <Frame>
        {error instanceof AdvisoryRateLimitedError ? (
          <ThrottleNotice error={error} />
        ) : (
          <p className="text-xs text-muted-foreground">
            The assistant could not be reached. Judge the candidates on the evidence the engine
            listed — nothing about this line has changed.
          </p>
        )}
      </Frame>
    );
  }

  if (!data) return null;

  if (!data.ai_available || !data.advisory) {
    return (
      <Frame>
        <p className="text-xs text-muted-foreground">
          {data.degraded_reason ?? "No advice available for this line."}
        </p>
      </Frame>
    );
  }

  const confidence = CONFIDENCE_COPY[data.advisory.confidence] ?? CONFIDENCE_COPY.low;

  return (
    <Frame>
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm">{data.advisory.recommendation}</p>
        <Badge variant={confidence.variant} className="shrink-0">
          {confidence.label}
        </Badge>
      </div>
      {data.advisory.reasoning && (
        <p className="text-xs text-muted-foreground">{data.advisory.reasoning}</p>
      )}
      {data.advisory.risks.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">What would make this wrong</p>
          <ul className="space-y-1">
            {data.advisory.risks.map((risk, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                <span>{risk}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <Alert className="py-2">
        <AlertDescription className="text-xs">
          This is a reading of the evidence, not a decision. You confirm the match.
        </AlertDescription>
      </Alert>
    </Frame>
  );
}

/** A readable narration of the recorded decision history, for an auditor. */
export function HistoryNarrativePanel({ bankTransactionId }: { bankTransactionId?: string }) {
  const [asked, setAsked] = useState(false);
  const { data, isLoading, error } = useHistoryNarrative(bankTransactionId, asked);

  if (!bankTransactionId) return null;

  if (!asked) {
    return <AskButton onClick={() => setAsked(true)} label="Summarise this history" />;
  }

  if (isLoading) {
    return (
      <Frame>
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Reading the decision record…
        </p>
      </Frame>
    );
  }

  if (error || !data) {
    return (
      <Frame>
        {error instanceof AdvisoryRateLimitedError ? (
          <ThrottleNotice error={error} />
        ) : (
          <p className="text-xs text-muted-foreground">
            The assistant could not be reached. The recorded decisions below are the authoritative
            account.
          </p>
        )}
      </Frame>
    );
  }

  if (!data.ai_available || !data.explanation) {
    return (
      <Frame>
        <p className="text-xs text-muted-foreground">
          {data.degraded_reason ?? "Nothing to summarise for this line."}
        </p>
      </Frame>
    );
  }

  return (
    <Frame>
      {data.explanation.summary && <p className="text-sm">{data.explanation.summary}</p>}
      {data.explanation.narrative && (
        <p className="text-xs text-muted-foreground">{data.explanation.narrative}</p>
      )}
      {data.explanation.open_questions.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">An auditor would still ask</p>
          <ul className="list-disc pl-4 space-y-0.5">
            {data.explanation.open_questions.map((q, i) => (
              <li key={i} className="text-xs text-muted-foreground">{q}</li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-xs text-muted-foreground italic">
        A summary of the record below — the record itself is the evidence.
      </p>
    </Frame>
  );
}
