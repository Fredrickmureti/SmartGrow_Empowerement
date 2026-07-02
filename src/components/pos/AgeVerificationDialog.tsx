import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ShieldAlert, Calendar, CreditCard, UserCheck } from "lucide-react";
import { differenceInYears, parse, isValid } from "date-fns";

interface AgeRestrictedItem {
  name: string;
  min_age: number;
}

interface AgeVerificationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  restrictedItems: AgeRestrictedItem[];
  requiredAge: number;
  onVerified: (method: "id_check" | "dob_entry" | "manager_override") => void;
  onCancel: () => void;
}

export function AgeVerificationDialog({
  open,
  onOpenChange,
  restrictedItems,
  requiredAge,
  onVerified,
  onCancel,
}: AgeVerificationDialogProps) {
  const [method, setMethod] = useState<"id_check" | "dob_entry" | "manager_override">("id_check");
  const [dob, setDob] = useState("");
  const [error, setError] = useState("");
  const [managerPin, setManagerPin] = useState("");

  const handleVerify = () => {
    setError("");

    if (method === "id_check") {
      // ID check - just confirm they checked
      onVerified("id_check");
    } else if (method === "dob_entry") {
      // Validate DOB
      const parsedDate = parse(dob, "yyyy-MM-dd", new Date());
      if (!isValid(parsedDate)) {
        setError("Please enter a valid date of birth");
        return;
      }

      const age = differenceInYears(new Date(), parsedDate);
      if (age < requiredAge) {
        setError(`Customer must be at least ${requiredAge} years old. Calculated age: ${age}`);
        return;
      }

      onVerified("dob_entry");
    } else if (method === "manager_override") {
      // In a real system, validate manager PIN
      if (managerPin.length < 4) {
        setError("Please enter a valid manager PIN");
        return;
      }
      onVerified("manager_override");
    }
  };

  const handleCancel = () => {
    onCancel();
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-destructive">
            <ShieldAlert className="h-5 w-5" />
            Age Verification Required
          </DialogTitle>
          <DialogDescription>
            This transaction contains age-restricted items
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Restricted Items */}
          <div className="p-3 bg-destructive/10 rounded-lg border border-destructive/20">
            <p className="text-sm font-medium mb-2">Restricted Items:</p>
            <div className="flex flex-wrap gap-2">
              {restrictedItems.map((item, idx) => (
                <Badge key={idx} variant="destructive">
                  {item.name} ({item.min_age}+)
                </Badge>
              ))}
            </div>
          </div>

          <Alert>
            <AlertDescription>
              Customer must be at least <strong>{requiredAge} years old</strong> to purchase these items.
            </AlertDescription>
          </Alert>

          {/* Verification Method */}
          <div className="space-y-3">
            <Label>Verification Method</Label>
            <RadioGroup
              value={method}
              onValueChange={(v) => setMethod(v as typeof method)}
              className="space-y-2"
            >
              <div className="flex items-center space-x-3 p-3 rounded-lg border hover:bg-muted/50 cursor-pointer">
                <RadioGroupItem value="id_check" id="id_check" />
                <Label htmlFor="id_check" className="flex items-center gap-2 cursor-pointer flex-1">
                  <CreditCard className="h-4 w-4" />
                  <div>
                    <p className="font-medium">ID Check</p>
                    <p className="text-sm text-muted-foreground">
                      Verified customer's ID shows age {requiredAge}+
                    </p>
                  </div>
                </Label>
              </div>

              <div className="flex items-center space-x-3 p-3 rounded-lg border hover:bg-muted/50 cursor-pointer">
                <RadioGroupItem value="dob_entry" id="dob_entry" />
                <Label htmlFor="dob_entry" className="flex items-center gap-2 cursor-pointer flex-1">
                  <Calendar className="h-4 w-4" />
                  <div>
                    <p className="font-medium">Enter Date of Birth</p>
                    <p className="text-sm text-muted-foreground">
                      Enter customer's DOB from their ID
                    </p>
                  </div>
                </Label>
              </div>

              <div className="flex items-center space-x-3 p-3 rounded-lg border hover:bg-muted/50 cursor-pointer">
                <RadioGroupItem value="manager_override" id="manager_override" />
                <Label htmlFor="manager_override" className="flex items-center gap-2 cursor-pointer flex-1">
                  <UserCheck className="h-4 w-4" />
                  <div>
                    <p className="font-medium">Manager Override</p>
                    <p className="text-sm text-muted-foreground">
                      Manager approves this sale
                    </p>
                  </div>
                </Label>
              </div>
            </RadioGroup>
          </div>

          {/* DOB Entry */}
          {method === "dob_entry" && (
            <div className="space-y-2">
              <Label htmlFor="dob">Date of Birth</Label>
              <Input
                id="dob"
                type="date"
                value={dob}
                onChange={(e) => setDob(e.target.value)}
                max={new Date().toISOString().split("T")[0]}
              />
            </div>
          )}

          {/* Manager PIN */}
          {method === "manager_override" && (
            <div className="space-y-2">
              <Label htmlFor="manager_pin">Manager PIN</Label>
              <Input
                id="manager_pin"
                type="password"
                value={managerPin}
                onChange={(e) => setManagerPin(e.target.value)}
                placeholder="Enter manager PIN"
                maxLength={6}
              />
            </div>
          )}

          {/* Error */}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleCancel}>
            Cancel Sale
          </Button>
          <Button onClick={handleVerify}>
            Confirm Age Verified
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
