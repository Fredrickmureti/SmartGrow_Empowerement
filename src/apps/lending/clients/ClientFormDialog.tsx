/**
 * Client register/edit dialog (C3).
 *
 * Captures KYC identity, owning branch and loan officer, and status. No loan
 * data is entered or derived here.
 */

import { useEffect, useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useBranches } from "@/hooks/useBranches";
import { useOrgMembers } from "@/hooks/useOrgMembers";
import {
  MF_CLIENT_STATUSES,
  MF_KYC_COLUMN,
  nextClientNumber,
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

const UNASSIGNED = "__unassigned__";

interface ClientFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: MfClient | null;
  existingClients: Array<{ client_number: string }>;
  onCreate: (input: MfClientInput) => Promise<MfClient>;
  onUpdate: (id: string, patch: Partial<MfClientInput>) => Promise<void>;
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
  existingClients,
  onCreate,
  onUpdate,
}: ClientFormDialogProps) {
  const { branches } = useBranches();
  const { members } = useOrgMembers();
  const [form, setForm] = useState<FormState>(EMPTY);
  const [images, setImages] = useState<Partial<Record<MfKycKind, KycPending>>>({});
  const [saving, setSaving] = useState(false);

  const setImage = (kind: MfKycKind) => (next: KycPending) =>
    setImages((prev) => ({ ...prev, [kind]: next }));

  useEffect(() => {
    if (!open) return;
    setImages({});
    if (client) {
      setForm({
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
      });
    } else {
      setForm({
        ...EMPTY,
        client_number: nextClientNumber(existingClients),
        branch_id: branches[0]?.id ?? "",
      });
    }
  }, [open, client, branches, existingClients]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const canSave =
    form.full_name.trim() !== "" &&
    form.client_number.trim() !== "" &&
    form.branch_id !== "";

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const payload: MfClientInput = {
        client_number: form.client_number.trim(),
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
          form.loan_officer_id === UNASSIGNED ? null : form.loan_officer_id,
        status: form.status,
        notes: orNull(form.notes),
      };
      // Existing client: upload images first, then one update with everything.
      // New client: insert first (we need the id), then patch image paths.
      const saved = client
        ? { id: client.id, business_id: client.business_id }
        : await onCreate(payload);

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
        await onUpdate(client.id, { ...payload, ...pathPatch });
      } else if (Object.keys(pathPatch).length > 0) {
        await onUpdate(saved.id, pathPatch);
      }
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not save the client's photos");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
                value={form.client_number}
                onChange={(e) => set("client_number", e.target.value)}
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
            <Input
              id="gender"
              value={form.gender}
              onChange={(e) => set("gender", e.target.value)}
            />
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
          <div className="space-y-1.5">
            <Label>Branch</Label>
            <Select value={form.branch_id} onValueChange={(v) => set("branch_id", v)}>
              <SelectTrigger>
                <SelectValue placeholder="Select branch" />
              </SelectTrigger>
              <SelectContent>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Loan officer</Label>
            <Select
              value={form.loan_officer_id}
              onValueChange={(v) => set("loan_officer_id", v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Unassigned" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                {members.map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {m.full_name || m.user_id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave || saving}>
            {client ? "Save changes" : "Register client"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default ClientFormDialog;
