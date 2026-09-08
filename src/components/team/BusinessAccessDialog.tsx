import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, Building2, Shield } from "lucide-react";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBusinessAccess } from "@/hooks/useBusinessAccess";

interface BusinessAccessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  member: {
    id: string;
    user_id: string;
    email: string;
    full_name: string | null;
    role: string;
  } | null;
}

interface BusinessSelection {
  businessId: string;
  isPrimary: boolean;
  canSwitch: boolean;
}

export function BusinessAccessDialog({
  open,
  onOpenChange,
  member,
}: BusinessAccessDialogProps) {
  const { businesses } = useBusinesses();
  const { accessRows, isLoading, isSaving, fetchAccess, saveAccess } =
    useBusinessAccess(member?.user_id);
  const [selections, setSelections] = useState<BusinessSelection[]>([]);

  // Fetch access rows when dialog opens
  useEffect(() => {
    if (open && member) {
      fetchAccess();
    }
  }, [open, member, fetchAccess]);

  // Initialize selections from fetched access rows
  useEffect(() => {
    if (open && accessRows.length >= 0) {
      setSelections(
        accessRows.map((r) => ({
          businessId: r.business_id,
          isPrimary: r.is_primary,
          canSwitch: r.can_switch,
        }))
      );
    }
  }, [open, accessRows]);

  const handleBusinessToggle = (businessId: string, checked: boolean) => {
    if (checked) {
      const isFirst = selections.length === 0;
      setSelections((prev) => [
        ...prev,
        { businessId, isPrimary: isFirst, canSwitch: true },
      ]);
    } else {
      setSelections((prev) => {
        const filtered = prev.filter((s) => s.businessId !== businessId);
        if (filtered.length > 0 && !filtered.some((s) => s.isPrimary)) {
          filtered[0].isPrimary = true;
        }
        return filtered;
      });
    }
  };

  const handlePrimaryChange = (businessId: string) => {
    setSelections((prev) =>
      prev.map((s) => ({
        ...s,
        isPrimary: s.businessId === businessId,
      }))
    );
  };

  const handleCanSwitchChange = (businessId: string, canSwitch: boolean) => {
    setSelections((prev) =>
      prev.map((s) =>
        s.businessId === businessId ? { ...s, canSwitch } : s
      )
    );
  };

  const handleSave = async () => {
    await saveAccess(
      selections.map((s) => ({
        business_id: s.businessId,
        is_primary: s.isPrimary,
        can_switch: s.canSwitch,
      }))
    );
    onOpenChange(false);
  };

  const isSelected = (businessId: string) =>
    selections.some((s) => s.businessId === businessId);

  const getSelection = (businessId: string) =>
    selections.find((s) => s.businessId === businessId);

  const isAdminOrOwner =
    member?.role === "admin" || member?.role === "owner";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            Business Access
          </DialogTitle>
          <DialogDescription>
            {member?.full_name || member?.email}
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : isAdminOrOwner ? (
          <div className="py-6 text-center">
            <Shield className="h-12 w-12 mx-auto text-primary/50 mb-3" />
            <p className="text-sm text-muted-foreground">
              <strong className="text-foreground">
                {member?.role === "owner" ? "Owners" : "Admins"}
              </strong>{" "}
              have automatic access to all businesses.
            </p>
          </div>
        ) : businesses.length === 0 ? (
          <div className="py-6 text-center text-muted-foreground">
            <Building2 className="h-12 w-12 mx-auto opacity-50 mb-3" />
            <p className="text-sm">No businesses available.</p>
          </div>
        ) : (
          <ScrollArea className="max-h-[400px] pr-4">
            <div className="space-y-4">
              {businesses.map((biz) => {
                const selected = isSelected(biz.id);
                const selection = getSelection(biz.id);

                return (
                  <div
                    key={biz.id}
                    className={`rounded-lg border p-4 transition-colors ${
                      selected
                        ? "border-primary bg-primary/5"
                        : "border-border"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <Checkbox
                        id={`biz-${biz.id}`}
                        checked={selected}
                        onCheckedChange={(checked) =>
                          handleBusinessToggle(biz.id, checked === true)
                        }
                      />
                      <div className="flex-1 space-y-2">
                        <Label
                          htmlFor={`biz-${biz.id}`}
                          className="font-medium cursor-pointer"
                        >
                          {biz.name}
                        </Label>

                        {selected && (
                          <div className="space-y-3 pt-2 border-t mt-2">
                            <div className="flex items-center justify-between">
                              <Label
                                htmlFor={`primary-biz-${biz.id}`}
                                className="text-sm text-muted-foreground cursor-pointer"
                              >
                                Primary business (default on login)
                              </Label>
                              <Switch
                                id={`primary-biz-${biz.id}`}
                                checked={selection?.isPrimary || false}
                                onCheckedChange={() =>
                                  handlePrimaryChange(biz.id)
                                }
                              />
                            </div>

                            <div className="flex items-center justify-between">
                              <Label
                                htmlFor={`switch-biz-${biz.id}`}
                                className="text-sm text-muted-foreground cursor-pointer"
                              >
                                Can switch to this business
                              </Label>
                              <Switch
                                id={`switch-biz-${biz.id}`}
                                checked={selection?.canSwitch || false}
                                onCheckedChange={(checked) =>
                                  handleCanSwitchChange(biz.id, checked)
                                }
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {!isAdminOrOwner && (
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              Save Access
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
