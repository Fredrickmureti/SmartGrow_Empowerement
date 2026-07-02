import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Loader2, AlertTriangle, UserMinus, ShieldAlert } from "lucide-react";
import { AppRole, ROLE_LABELS } from "@/lib/permissions";

interface TeamMember {
  id: string;
  user_id: string;
  role: AppRole;
  email: string;
  full_name: string | null;
}

interface RemoveMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  member: TeamMember | null;
  onConfirm: (memberId: string) => Promise<void>;
}

const roleColors: Record<AppRole, string> = {
  super_admin: "bg-purple-500/10 text-purple-500",
  owner: "bg-primary/10 text-primary",
  admin: "bg-blue-500/10 text-blue-500",
  internal: "bg-indigo-500/10 text-indigo-500",
  accountant: "bg-green-500/10 text-green-500",
  staff: "bg-orange-500/10 text-orange-500",
  cashier: "bg-cyan-500/10 text-cyan-500",
  viewer: "bg-muted text-muted-foreground",
  portal: "bg-teal-500/10 text-teal-500",
};

export function RemoveMemberDialog({ 
  open, 
  onOpenChange, 
  member, 
  onConfirm 
}: RemoveMemberDialogProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [confirmEmail, setConfirmEmail] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setStep(1);
      setConfirmEmail("");
    }
    onOpenChange(open);
  };

  const handleConfirm = async () => {
    if (!member) return;
    
    setIsSubmitting(true);
    try {
      await onConfirm(member.id);
      handleOpenChange(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!member) return null;

  const emailMatches = confirmEmail.toLowerCase() === member.email.toLowerCase();

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {step === 1 && <UserMinus className="h-5 w-5 text-destructive" />}
            {step === 2 && <ShieldAlert className="h-5 w-5 text-destructive" />}
            {step === 3 && <AlertTriangle className="h-5 w-5 text-destructive" />}
            Remove Team Member
          </DialogTitle>
          <DialogDescription>
            {step === 1 && "This will revoke their access to your organization."}
            {step === 2 && "Please confirm by typing the member's email address."}
            {step === 3 && "Final confirmation required."}
          </DialogDescription>
        </DialogHeader>

        {step === 1 && (
          <div className="space-y-4 py-4">
            <div className="rounded-lg border p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">{member.full_name || member.email}</p>
                  {member.full_name && (
                    <p className="text-sm text-muted-foreground">{member.email}</p>
                  )}
                </div>
                <Badge variant="secondary" className={roleColors[member.role]}>
                  {ROLE_LABELS[member.role]}
                </Badge>
              </div>
            </div>

            <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-4 space-y-2">
              <p className="text-sm font-medium text-destructive">What happens when you remove this member:</p>
              <ul className="text-sm text-muted-foreground space-y-1 list-disc list-inside">
                <li>They will lose access to this organization immediately</li>
                <li>Their work and history will remain in the system</li>
                <li>They can be re-invited later if needed</li>
              </ul>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="confirm-email">
                Type <strong>{member.email}</strong> to confirm
              </Label>
              <Input
                id="confirm-email"
                type="email"
                placeholder="Enter email address"
                value={confirmEmail}
                onChange={(e) => setConfirmEmail(e.target.value)}
                autoComplete="off"
              />
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4 py-4">
            <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-6 text-center space-y-3">
              <AlertTriangle className="h-10 w-10 text-destructive mx-auto" />
              <div>
                <p className="font-semibold">Are you absolutely sure?</p>
                <p className="text-sm text-muted-foreground mt-1">
                  You are about to remove <strong>{member.full_name || member.email}</strong> from this organization.
                </p>
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          {step === 1 && (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => setStep(2)}>
                Continue
              </Button>
            </>
          )}
          {step === 2 && (
            <>
              <Button variant="outline" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button 
                variant="destructive" 
                onClick={() => setStep(3)}
                disabled={!emailMatches}
              >
                Continue
              </Button>
            </>
          )}
          {step === 3 && (
            <>
              <Button variant="outline" onClick={() => setStep(2)}>
                Back
              </Button>
              <Button 
                variant="destructive" 
                onClick={handleConfirm}
                disabled={isSubmitting}
              >
                {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Remove Member
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
