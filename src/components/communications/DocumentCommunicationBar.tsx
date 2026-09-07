import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { MessageSquare, Mail, FlaskConical, Radio } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useSmsAvailability } from "@/hooks/useSmsAvailability";

export interface DocumentCommunicationContext {
  /** Logical entity type, e.g. "invoice", "estimate". */
  entityType: string;
  entityId: string;
  /** Optional business scope for the SMS log. */
  businessId?: string | null;
  /** Phone of the document's primary contact (customer/vendor/employee). */
  recipientPhone?: string | null;
  /** Display name for the recipient in the dialog. */
  recipientName?: string | null;
  /** Variables for SMS template substitution. */
  variables?: Record<string, string>;
  /** Optional custom Email handler. If omitted, the Email button is hidden. */
  onEmail?: () => void;
}

interface DocumentCommunicationBarProps extends DocumentCommunicationContext {
  className?: string;
  size?: "sm" | "default";
}

/**
 * Shared communication action bar for any document surface
 * (preview dialogs, detail dialogs, list rows…).
 *
 * Decides per-channel availability via state-aware hooks and renders
 * each channel as a button — disabled with a tooltip explaining
 * why when the channel is configured but not actionable in this
 * context. SMS that is not configured at all stays hidden so the
 * UI doesn't advertise capabilities the org doesn't have.
 */
export function DocumentCommunicationBar({
  entityType,
  entityId,
  businessId,
  recipientPhone,
  recipientName,
  variables,
  onEmail,
  className,
  size = "sm",
}: DocumentCommunicationBarProps) {
  const [smsOpen, setSmsOpen] = useState(false);
  const sms = useSmsAvailability({ recipientPhone });

  // Hide SMS entirely when the integration isn't configured at all —
  // there is nothing for the user to act on. When configured but
  // unavailable in this context, render disabled with a tooltip so
  // the user understands why instead of seeing the action vanish.
  const showSmsButton = sms.configured || sms.isLoading;

  if (!showSmsButton && !onEmail) return null;

  return (
    <TooltipProvider>
      <div className={`flex items-center gap-2 flex-wrap ${className ?? ""}`}>
        {onEmail && (
          <Button variant="outline" size={size} onClick={onEmail}>
            <Mail className="mr-2 h-4 w-4" />
            Email
          </Button>
        )}

        {showSmsButton && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  variant="outline"
                  size={size}
                  disabled={!sms.canSend}
                  onClick={() => setSmsOpen(true)}
                >
                  <MessageSquare className="mr-2 h-4 w-4" />
                  SMS
                  {sms.mode && (
                    <Badge
                      variant={sms.mode === "live" ? "default" : "secondary"}
                      className="ml-2 gap-1 px-1.5 py-0 text-[10px] leading-4"
                    >
                      {sms.mode === "live" ? (
                        <Radio className="h-2.5 w-2.5" />
                      ) : (
                        <FlaskConical className="h-2.5 w-2.5" />
                      )}
                      {sms.mode === "live" ? "Live" : "Test"}
                    </Badge>
                  )}
                </Button>
              </span>
            </TooltipTrigger>
            {!sms.canSend && sms.reasonMessage && (
              <TooltipContent>{sms.reasonMessage}</TooltipContent>
            )}
          </Tooltip>
        )}

      </div>
    </TooltipProvider>
  );
}
