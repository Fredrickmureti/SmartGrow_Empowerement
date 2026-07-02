import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { MessageSquare } from "lucide-react";
import { useSmsAvailability } from "@/hooks/useSmsAvailability";
import { SendSmsDialog } from "./SendSmsDialog";

interface SendSmsButtonProps {
  recipientPhone?: string;
  recipientName?: string;
  variables?: Record<string, string>;
  context?: {
    entityType: string;
    entityId: string;
    businessId?: string;
  };
  variant?: "default" | "ghost" | "outline" | "secondary";
  size?: "default" | "sm" | "icon";
  className?: string;
}

/**
 * "Send SMS" button used inside per-document detail dialogs.
 *
 * State-aware: hides only when SMS is not configured at the org level
 * (nothing to advertise). When configured but unavailable in this
 * context (no recipient phone, opted-out, missing permission, …),
 * renders disabled with a tooltip explaining why instead of silently
 * vanishing.
 */
export function SendSmsButton({
  recipientPhone,
  recipientName,
  variables = {},
  context,
  variant = "outline",
  size = "sm",
  className,
}: SendSmsButtonProps) {
  const sms = useSmsAvailability({ recipientPhone });
  const [open, setOpen] = useState(false);

  // Hide entirely when SMS isn't configured for the org — there is
  // nothing for the user to act on. Keep visible while loading so
  // the button doesn't pop in late.
  if (!sms.configured && !sms.isLoading) return null;

  const button = (
    <Button
      variant={variant}
      size={size}
      onClick={() => setOpen(true)}
      className={className}
      disabled={!sms.canSend}
    >
      <MessageSquare className="mr-2 h-4 w-4" />
      Send SMS
    </Button>
  );

  return (
    <>
      {!sms.canSend && sms.reasonMessage ? (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild><span>{button}</span></TooltipTrigger>
            <TooltipContent>{sms.reasonMessage}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        button
      )}
      <SendSmsDialog
        open={open}
        onOpenChange={setOpen}
        recipientPhone={sms.recipientPhone ?? recipientPhone}
        recipientName={recipientName}
        variables={variables}
        context={context}
      />
    </>
  );
}
