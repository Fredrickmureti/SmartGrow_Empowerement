/**
 * RequestAppAccessDialog — shown when a user clicks an app the org has
 * installed but the user lacks RBAC permission for.
 *
 * Posts an `approval_requests` row of type 'app_access' that the tenant
 * admin sees in their pending-approvals queue.
 */
import { useState } from "react";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAppAccessRequest } from "@/hooks/useAppAccessRequest";
import type { AppDefinition } from "@/lib/apps/types";

interface RequestAppAccessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  app: AppDefinition;
}

export function RequestAppAccessDialog({
  open,
  onOpenChange,
  app,
}: RequestAppAccessDialogProps) {
  const [message, setMessage] = useState("");
  const { requestAccess, isSubmitting } = useAppAccessRequest();

  async function handleSubmit() {
    try {
      await requestAccess(app.id, message.trim() || undefined);
      setMessage("");
      onOpenChange(false);
    } catch {
      /* handled in hook */
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Lock className="h-4 w-4 text-muted-foreground" />
            Request access to {app.name}
          </DialogTitle>
          <DialogDescription>
            Your organization has {app.name} installed, but you don't have
            permission to use it yet. Send a request to your administrator.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label htmlFor="access-message">
            Why do you need access? <span className="text-muted-foreground">(optional)</span>
          </Label>
          <Textarea
            id="access-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder={`Briefly explain how you'll use ${app.name}…`}
            rows={4}
            maxLength={500}
          />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting}>
            {isSubmitting ? "Sending…" : "Send request"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
