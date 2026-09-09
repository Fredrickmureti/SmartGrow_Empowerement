/**
 * Client register/edit dialog (C3).
 *
 * Captures KYC identity, owning branch and loan officer, and status. No loan
 * data is entered or derived here.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBranches } from "@/hooks/useBranches";
import { useBranchOfficers } from "@/hooks/useBranchOfficers";
import { useAuth } from "@/contexts/AuthContext";
import { useBranchScope } from "@/hooks/useBranchScope";
import { useMfGroups } from "@/hooks/useMfGroups";
import {
  MF_CLIENT_STATUSES,
  MF_KYC_COLUMN,
  removeKycImage,
  uploadKycImage,
  type MfClient,
  type MfClientInput,
  type MfClientStatus,
  type MfKycKind,
} from "@/hooks/useMfClients";
import { toast } from "sonner";
import { Separator } from "@/components/ui/separator";
import { KycCaptureField, type KycPending } from "./KycCaptureField";
import { lendingErrorMessage } from "@/lib/lending/lendingError";

const UNASSIGNED = "__unassigned__";
const UNSPECIFIED = "__unspecified__";


interface ClientFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: MfClient | null;
  onCreate: (input: MfClientInput) => Promise<MfClient>;
  onUpdate: (id: string, patch: Partial<MfClientInput>) => Promise<void>;
  /**
   * Set when the officer is registering this client during a group meeting in
   * the field. The group is fixed to the meeting's group and the client is
   * stamped with the meeting, so the meeting record shows who joined at it.
   */
  meetingContext?: { meetingId: string; groupId: string } | null;
}


interface FormState {
  client_number: string;
  full_name: string;
  national_id: string;
  date_of_birth: string;
  gender: string;
  phone: string;
  email: string;
  physical_address: string;
  occupation: string;
  business_type: string;
  business_location: string;
  next_of_kin_name: string;
  next_of_kin_relationship: string;
  next_of_kin_phone: string;
  branch_id: string;
  loan_officer_id: string;
  status: MfClientStatus;
  notes: string;
}

const EMPTY: FormState = {
  client_number: "",
  full_name: "",
  national_id: "",
  date_of_birth: "",
  gender: "",
  phone: "",
  email: "",
  physical_address: "",
  occupation: "",
  business_type: "",
  business_location: "",
  next_of_kin_name: "",
  next_of_kin_relationship: "",
  next_of_kin_phone: "",
  branch_id: "",
  loan_officer_id: UNASSIGNED,
  status: "prospect",
  notes: "",
};

const orNull = (v: string) => (v.trim() === "" ? null : v.trim());

export function ClientFormDialog({
  open,
  onOpenChange,
  client,
  onCreate,
  onUpdate,
  meetingContext = null,
}: ClientFormDialogProps) {
  const { branches } = useBranches();
  const { officers } = useBranchOfficers();
  const { user } = useAuth();
  const branchScope = useBranchScope();
  const { groups } = useMfGroups({ status: "all" });
  const [form, setForm] = useState<FormState>(EMPTY);
  const [images, setImages] = useState<Partial<Record<MfKycKind, KycPending>>>({});
  const [groupId, setGroupId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Snapshot of the values the dialog opened with, so Cancel can tell an
  // untouched form from one with unsaved edits.
  const baselineRef = useRef<string>("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Identity of a client already created in a previous, partially failed save.
  // Retrying after a photo upload error must patch this client, never insert a
  // second one.
  const createdRef = useRef<{ id: string; business_id: string } | null>(null);

  // Branches this user may actually operate in. RLS enforces the same rule;
  // this only stops the user submitting work the server would reject.
  const allowedBranches = useMemo(
    () => branches.filter((b) => branchScope.canAccessBranch(b.id)),
    [branches, branchScope],
  );

  // An own-portfolio officer may only own their own clients, so the officer is
  // fixed to themselves and not editable.
  const officerLocked = branchScope.isOwnPortfolioOnly && !!user?.id;

  // Only staff with a branch assignment inside a branch this user may operate
  // in; `mf_register_client` refuses anything else.
  const officerOptions = useMemo(
    () =>
      officers.filter((o) =>
        o.branchIds.some((id) => allowedBranches.some((b) => b.id === id)),
      ),
    [officers, allowedBranches],
  );

  const selectedOfficer = useMemo(
    () =>
      form.loan_officer_id === UNASSIGNED
        ? null
        : (officers.find((o) => o.user_id === form.loan_officer_id) ?? null),
    [officers, form.loan_officer_id],
  );

  // With an officer chosen, only their branches are offered.
  const branchOptions = useMemo(() => {
    if (!selectedOfficer) return allowedBranches;
    return allowedBranches.filter((b) => selectedOfficer.branchIds.includes(b.id));
  }, [allowedBranches, selectedOfficer]);

  // Open groups of this officer in this branch. No silent fallback to
  // unrelated groups.
  const availableGroups = useMemo(() => {
    // Inside a meeting the group is the meeting's group, full stop.
    if (meetingContext) {
      return groups.filter((g) => g.id === meetingContext.groupId);
    }
    if (!form.branch_id) return [];
    return groups.filter(
      (g) =>
        g.status !== "closed" &&
        g.branch_id === form.branch_id &&
        (!selectedOfficer || g.loan_officer_id === selectedOfficer.user_id),
    );
  }, [groups, form.branch_id, selectedOfficer, meetingContext]);

  const chooseOfficer = (value: string) => {
    setForm((prev) => {
      const officer = value === UNASSIGNED ? null : officers.find((o) => o.user_id === value);
      const usable = officer
        ? allowedBranches.filter((b) => officer.branchIds.includes(b.id))
        : allowedBranches;
      const branch_id =
        officer && usable.length === 1
          ? usable[0]!.id
          : usable.some((b) => b.id === prev.branch_id)
            ? prev.branch_id
            : "";
      return { ...prev, loan_officer_id: value, branch_id };
    });
    setGroupId(null);
  };

  const chooseBranch = (value: string) => {
    set("branch_id", value);
    setGroupId(null);
  };

  // Selecting a group first fills in its branch and officer.
  const chooseGroup = (value: string) => {
    if (value === UNASSIGNED) {
      setGroupId(null);
      return;
    }
    setGroupId(value);
    const group = groups.find((g) => g.id === value);
    if (!group) return;
    setForm((prev) => ({
      ...prev,
      branch_id: group.branch_id ?? prev.branch_id,
      loan_officer_id:
        prev.loan_officer_id === UNASSIGNED && group.loan_officer_id
          ? group.loan_officer_id
          : prev.loan_officer_id,
    }));
  };

  const setImage = (kind: MfKycKind) => (next: KycPending) =>
    setImages((prev) => ({ ...prev, [kind]: next }));

  useEffect(() => {
    if (!open) return;
    setImages({});
    setGroupId(null);
    createdRef.current = null;
    setConfirmDiscard(false);
    const snapshot = (next: FormState) => {
      baselineRef.current = JSON.stringify(next);
      return next;
    };
    if (client) {
      setForm(snapshot({
        client_number: client.client_number,
        full_name: client.full_name,
        national_id: client.national_id ?? "",
        date_of_birth: client.date_of_birth ?? "",
        gender: client.gender ?? "",
        phone: client.phone ?? "",
        email: client.email ?? "",
        physical_address: client.physical_address ?? "",
        occupation: client.occupation ?? "",
        business_type: client.business_type ?? "",
        business_location: client.business_location ?? "",
        next_of_kin_name: client.next_of_kin_name ?? "",
        next_of_kin_relationship: client.next_of_kin_relationship ?? "",
        next_of_kin_phone: client.next_of_kin_phone ?? "",
        branch_id: client.branch_id,
        loan_officer_id: client.loan_officer_id ?? UNASSIGNED,
        status: client.status,
        notes: client.notes ?? "",
      }));
    } else {
      setForm(snapshot({
        ...EMPTY,
        branch_id:
          branchScope.defaultBranchId ?? allowedBranches[0]?.id ?? "",
        loan_officer_id:
          branchScope.isOwnPortfolioOnly && user?.id ? user.id : UNASSIGNED,
      }));
      if (meetingContext) setGroupId(meetingContext.groupId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, client]);

  // Registering from inside a meeting: the group is fixed to the meeting's
  // group, and its branch and loan officer are taken from that group.
  useEffect(() => {
    if (!open || client || !meetingContext) return;
    const group = groups.find((g) => g.id === meetingContext.groupId);
    if (!group) return;
    setGroupId(group.id);
    setForm((prev) => ({
      ...prev,
      branch_id: group.branch_id ?? prev.branch_id,
      loan_officer_id:
        prev.loan_officer_id === UNASSIGNED && group.loan_officer_id
          ? group.loan_officer_id
          : prev.loan_officer_id,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, client, meetingContext?.groupId, groups]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));


  const isDirty =
    JSON.stringify(form) !== baselineRef.current ||
    Object.keys(images).length > 0;

  // Cancel discards; it only asks first when there is something to lose.
  const requestClose = () => {
    if (saving) return;
    if (isDirty) {
      setConfirmDiscard(true);
      return;
    }
    onOpenChange(false);
  };

  const canSave =
    form.full_name.trim() !== "" &&
    form.branch_id !== "" &&
    branchScope.canAccessBranch(form.branch_id);

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const payload: MfClientInput = {
        full_name: form.full_name.trim(),
        branch_id: form.branch_id,
        national_id: orNull(form.national_id),
        date_of_birth: orNull(form.date_of_birth),
        gender: orNull(form.gender),
        phone: orNull(form.phone),
        email: orNull(form.email),
        physical_address: orNull(form.physical_address),
        occupation: orNull(form.occupation),
        business_type: orNull(form.business_type),
        business_location: orNull(form.business_location),
        next_of_kin_name: orNull(form.next_of_kin_name),
        next_of_kin_relationship: orNull(form.next_of_kin_relationship),
        next_of_kin_phone: orNull(form.next_of_kin_phone),
        loan_officer_id:
          officerLocked
            ? user!.id
            : form.loan_officer_id === UNASSIGNED
              ? null
              : form.loan_officer_id,
        status: form.status,
        notes: orNull(form.notes),
      };
      // Branch, loan officer and status are controlled changes made one at a
      // time from the detail sheet — a generic profile edit never sends them.
      const editPatch: Partial<MfClientInput> = { ...payload };
      delete (editPatch as Record<string, unknown>).branch_id;
      delete (editPatch as Record<string, unknown>).loan_officer_id;
      delete (editPatch as Record<string, unknown>).status;
      // Existing client: upload images first, then one update with everything.
      // New client: insert once (we need the id), then patch image paths. If a
      // photo upload fails we keep the created identity so a retry updates that
      // same client instead of registering a duplicate.
      const saved = client
        ? { id: client.id, business_id: client.business_id }
        : (createdRef.current ??= await onCreate({
            ...payload,
            group_id: meetingContext ? meetingContext.groupId : groupId,
            onboarded_meeting_id: meetingContext?.meetingId ?? null,
          }));

      if (!client && createdRef.current) {
        // Retry path: keep the stored record in step with the edited form.
        await onUpdate(saved.id, payload);
      }

      const pathPatch: Partial<MfClientInput> = {};
      for (const [kind, pending] of Object.entries(images) as [MfKycKind, KycPending][]) {
        if (pending === undefined) continue;
        const column = MF_KYC_COLUMN[kind] as keyof MfClientInput;
        const stored = client?.[MF_KYC_COLUMN[kind]] as string | null | undefined;
        if (pending === null) {
          if (stored) await removeKycImage(stored).catch(() => undefined);
          (pathPatch as Record<string, unknown>)[column] = null;
        } else {
          (pathPatch as Record<string, unknown>)[column] = await uploadKycImage(
            saved.business_id,
            saved.id,
            kind,
            pending,
          );
        }
      }

      if (client) {
        await onUpdate(client.id, { ...editPatch, ...pathPatch });
      } else if (Object.keys(pathPatch).length > 0) {
        await onUpdate(saved.id, pathPatch);
      }


      createdRef.current = null;
      onOpenChange(false);
    } catch (e) {
      toast.error(lendingErrorMessage(e, "Could not save the client's photos"));
    } finally {
      setSaving(false);
    }
  };


  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        requestClose();
      }}
    >
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{client ? "Edit client" : "Register client"}</DialogTitle>
          <DialogDescription>
            KYC identity, owning branch and loan officer. Lending terms are
            captured later, on the application.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-[9rem_1fr]">
          <KycCaptureField
            label="Client photo"
            hint="Passport-style photo"
            frame="portrait"
            storedPath={client?.photo_path ?? null}
            pending={images.photo}
            onChange={setImage("photo")}
          />
          <div className="grid content-start gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="client_number">Client number</Label>
              <Input
                id="client_number"
                value={client ? form.client_number : "Assigned automatically"}
                readOnly
                disabled
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="full_name">Full name</Label>
              <Input
                id="full_name"
                value={form.full_name}
                onChange={(e) => set("full_name", e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="national_id">National ID</Label>
              <Input
                id="national_id"
                value={form.national_id}
                onChange={(e) => set("national_id", e.target.value)}
              />
            </div>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <KycCaptureField
            label="ID card — front"
            hint="Front side of the national ID"
            frame="card"
            storedPath={client?.id_front_path ?? null}
            pending={images.id_front}
            onChange={setImage("id_front")}
          />
          <KycCaptureField
            label="ID card — back"
            hint="Back side of the national ID"
            frame="card"
            storedPath={client?.id_back_path ?? null}
            pending={images.id_back}
            onChange={setImage("id_back")}
          />
        </div>

        <Separator />

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="date_of_birth">Date of birth</Label>
            <Input
              id="date_of_birth"
              type="date"
              value={form.date_of_birth}
              onChange={(e) => set("date_of_birth", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="gender">Gender</Label>
            <Select
              value={form.gender === "" ? UNSPECIFIED : form.gender}
              onValueChange={(v) => set("gender", v === UNSPECIFIED ? "" : v)}
            >
              <SelectTrigger id="gender">
                <SelectValue placeholder="Not specified" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNSPECIFIED}>Not specified</SelectItem>
                <SelectItem value="female">Female</SelectItem>
                <SelectItem value="male">Male</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="phone">Phone</Label>
            <Input
              id="phone"
              value={form.phone}
              onChange={(e) => set("phone", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              value={form.email}
              onChange={(e) => set("email", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="physical_address">Physical address</Label>
            <Input
              id="physical_address"
              value={form.physical_address}
              onChange={(e) => set("physical_address", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="occupation">Occupation</Label>
            <Input
              id="occupation"
              value={form.occupation}
              onChange={(e) => set("occupation", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="business_type">Business type</Label>
            <Input
              id="business_type"
              value={form.business_type}
              onChange={(e) => set("business_type", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="business_location">Business location</Label>
            <Input
              id="business_location"
              value={form.business_location}
              onChange={(e) => set("business_location", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="next_of_kin_name">Next of kin</Label>
            <Input
              id="next_of_kin_name"
              value={form.next_of_kin_name}
              onChange={(e) => set("next_of_kin_name", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="next_of_kin_relationship">Kin relationship</Label>
            <Input
              id="next_of_kin_relationship"
              value={form.next_of_kin_relationship}
              onChange={(e) => set("next_of_kin_relationship", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="next_of_kin_phone">Kin phone</Label>
            <Input
              id="next_of_kin_phone"
              value={form.next_of_kin_phone}
              onChange={(e) => set("next_of_kin_phone", e.target.value)}
            />
          </div>
          <div className="grid gap-4 sm:col-span-2 sm:grid-cols-2">
            <KycCaptureField
              label="Kin ID — front"
              optional
              hint="Front of the next of kin's ID"
              frame="card"
              storedPath={client?.kin_id_front_path ?? null}
              pending={images.kin_id_front}
              onChange={setImage("kin_id_front")}
            />
            <KycCaptureField
              label="Kin ID — back"
              optional
              hint="Back of the next of kin's ID"
              frame="card"
              storedPath={client?.kin_id_back_path ?? null}
              pending={images.kin_id_back}
              onChange={setImage("kin_id_back")}
            />
          </div>
          {/* Branch, loan officer, status and group are set at registration and
              changed afterwards only through their own deliberate actions on
              the client detail sheet. */}
          {!client && (
            <>
              <div className="space-y-1.5">
                <Label>Loan officer</Label>
                <Select
                  value={form.loan_officer_id}
                  onValueChange={chooseOfficer}
                  disabled={officerLocked}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Unassigned" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                    {officerOptions.map((o) => (
                      <SelectItem key={o.user_id} value={o.user_id}>
                        {o.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {officerOptions.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No staff are assigned to a branch yet.
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label>Branch</Label>
                <Select value={form.branch_id} onValueChange={chooseBranch}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select branch" />
                  </SelectTrigger>
                  <SelectContent>
                    {branchOptions.map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedOfficer && branchOptions.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    This loan officer is not assigned to a branch.
                  </p>
                )}
                {selectedOfficer && selectedOfficer.branchIds.length === 1 && form.branch_id && (
                  <p className="text-xs text-muted-foreground">
                    Taken from this loan officer's branch.
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label>Group</Label>
                <Select
                  value={groupId ?? UNASSIGNED}
                  onValueChange={chooseGroup}
                  disabled={!!meetingContext}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="No group" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNASSIGNED}>No group</SelectItem>
                    {availableGroups.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {meetingContext
                    ? "Fixed to the group whose meeting you are recording."
                    : !form.branch_id
                      ? "Choose a loan officer or branch to see their groups."
                      : availableGroups.length === 0
                        ? "No groups for this loan officer in this branch."
                        : "Optional. A client can belong to one group at a time."}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label>Status</Label>
                <Select
                  value={form.status}
                  onValueChange={(v) => set("status", v as MfClientStatus)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MF_CLIENT_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="notes">Notes</Label>
            <Textarea
              id="notes"
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={requestClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave || saving}>
            {client ? "Save changes" : "Register client"}
          </Button>
        </DialogFooter>

        <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
              <AlertDialogDescription>
                The changes you made to this client have not been saved yet.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep editing</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  setConfirmDiscard(false);
                  onOpenChange(false);
                }}
              >
                Discard
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}

export default ClientFormDialog;
