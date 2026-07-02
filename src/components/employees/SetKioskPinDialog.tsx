/**
 * SetKioskPinDialog — HR action to set/reset an employee's kiosk PIN.
 *
 * Hashing happens server-side via the SECURITY DEFINER RPC
 * `set_employee_kiosk_pin(_employee_id, _pin)`. The PIN is never persisted
 * client-side and never echoed back.
 *
 * Migrated to the WorkflowSheet design standard.
 */
import { useState } from "react";
import { Loader2, KeyRound } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  WorkflowSheet,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";

interface Props {
  employeeId: string;
  employeeName?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SetKioskPinDialog({ employeeId, employeeName, open, onOpenChange }: Props) {
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setPin("");
    setConfirm("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^\d{4,8}$/.test(pin)) {
      toast.error("PIN must be 4–8 digits");
      return;
    }
    if (pin !== confirm) {
      toast.error("PINs do not match");
      return;
    }
    setSubmitting(true);
    const { error } = await supabase.rpc("set_employee_kiosk_pin", {
      _employee_id: employeeId,
      _pin: pin,
    });
    setSubmitting(false);
    if (error) {
      const msg = error.message.includes("PERMISSION_DENIED")
        ? "You don't have permission to set this PIN."
        : error.message.includes("INVALID_PIN_LENGTH")
          ? "PIN must be between 4 and 12 digits."
          : error.message || "Failed to set PIN";
      toast.error(msg);
      return;
    }
    toast.success("Kiosk PIN updated");
    reset();
    onOpenChange(false);
  };

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <KeyRound className="h-4 w-4" /> Set Kiosk PIN
        </span>
      }
      description={
        <>
          {employeeName
            ? `${employeeName} will use this PIN to clock in/out from the kiosk.`
            : "The employee will use this PIN to clock in/out from the kiosk."}{" "}
          The PIN is hashed on the server and cannot be recovered — only reset.
        </>
      }
      onSubmit={handleSubmit}
      footer={
        <>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting || !pin || !confirm} onClick={handleSubmit as any}>
            {submitting && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
            Save PIN
          </Button>
        </>
      }
    >
      <WorkflowSheetSection number={1} title="PIN" subtitle="Numeric 4–8 digits. Stored hashed.">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <WorkflowField label="New PIN" required>
            <Input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={8}
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              required
            />
          </WorkflowField>
          <WorkflowField label="Confirm PIN" required>
            <Input
              type="password"
              inputMode="numeric"
              autoComplete="new-password"
              maxLength={8}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value.replace(/\D/g, ""))}
              required
            />
          </WorkflowField>
        </div>
      </WorkflowSheetSection>
    </WorkflowSheet>
  );
}
