/**
 * MyProfilePage — the canonical ESS profile surface at `/me/profile`.
 *
 * Replaces the previous `/hr/MyProfile.tsx` redirect-shim that punched
 * portal users into `/hr/employees/:id` (an admin route that the portal
 * guard promptly bounced back to `/me`).
 *
 * Ownership model enforced by this page:
 *   1. HR record card — read-only. HR owns legal name, employment,
 *      manager, national ID, DOB, bank. "Request correction" opens a
 *      change-request dialog → submit_profile_change_request RPC.
 *   2. Personal details card — employee-editable via
 *      update_own_employee_personal RPC (whitelisted columns only).
 *   3. Emergency contact card — employee-editable via same RPC.
 *
 * All reads go through the security_invoker view v_my_employee_profile
 * so this page works for portal users who have zero HR module permissions.
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, ShieldCheck, User as UserIcon, Phone, MapPin, HeartPulse, Landmark, Send } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/contexts/AuthContext";
import { PageHeader, PageBody } from "@/design-system";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import EmployeeLinkRequired from "@/components/me/EmployeeLinkRequired";

type MyProfile = {
  id: string;
  employee_number: string;
  first_name: string;
  last_name: string;
  work_email: string | null;
  email: string | null;
  personal_phone: string | null;
  phone: string | null;
  gender: string | null;
  date_of_birth: string | null;
  marital_status: string | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  county: string | null;
  postal_code: string | null;
  country: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  hire_date: string | null;
  employment_type: string | null;
  lifecycle_status: string | null;
  national_id_masked: string | null;
  bank_account_masked: string | null;
  bank_name: string | null;
  bank_branch: string | null;
};

const HR_CHANGE_REQUEST_FIELDS = [
  { key: "first_name", label: "Legal first name" },
  { key: "last_name", label: "Legal last name" },
  { key: "national_id", label: "National ID" },
  { key: "date_of_birth", label: "Date of birth" },
  { key: "bank_name", label: "Bank name" },
  { key: "bank_branch", label: "Bank branch" },
  { key: "bank_account_number", label: "Bank account number" },
] as const;

export default function MyProfilePage() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["my-employee-profile", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("v_my_employee_profile" as any)
        .select("*")
        .maybeSingle();
      if (error) throw error;
      return data as unknown as MyProfile | null;
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!data) return <EmployeeLinkRequired />;

  const refresh = () => qc.invalidateQueries({ queryKey: ["my-employee-profile"] });

  return (
    <>
      <PageHeader
        title="My profile"
        description="Your employment record and personal contact information."
      />
      <PageBody>
        <div className="space-y-4">
          <HrRecordCard profile={data} />
          <MyChangeRequestsStrip employeeId={data.id} />
          <PersonalDetailsCard profile={data} onSaved={refresh} />
          <EmergencyContactCard profile={data} onSaved={refresh} />
          <BankAndIdCard profile={data} />
        </div>
      </PageBody>
    </>
  );
}

// ---------------------------------------------------------------------------
// 1. HR record (read-only)
// ---------------------------------------------------------------------------

function HrRecordCard({ profile }: { profile: MyProfile }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            <UserIcon className="h-4 w-4" /> HR record
          </CardTitle>
          <CardDescription>Managed by your HR team. Read-only here.</CardDescription>
        </div>
        <Badge variant="secondary" className="gap-1">
          <ShieldCheck className="h-3 w-3" /> Managed by HR
        </Badge>
      </CardHeader>
      <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-sm">
        <Field label="Legal name" value={`${profile.first_name} ${profile.last_name}`} />
        <Field label="Employee number" value={profile.employee_number} />
        <Field label="Work email" value={profile.work_email ?? profile.email} />
        <Field label="Employment type" value={profile.employment_type} />
        <Field label="Hire date" value={profile.hire_date} />
        <Field label="Status" value={profile.lifecycle_status} />
        <Field label="Date of birth" value={profile.date_of_birth} />
        <Field label="Gender" value={profile.gender} />
        <div className="md:col-span-2 pt-2">
          <ChangeRequestDialog />
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 2. Personal details (self-editable)
// ---------------------------------------------------------------------------

function PersonalDetailsCard({ profile, onSaved }: { profile: MyProfile; onSaved: () => void }) {
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    personal_phone: profile.personal_phone ?? "",
    phone: profile.phone ?? "",
    marital_status: profile.marital_status ?? "",
    address_line1: profile.address_line1 ?? "",
    address_line2: profile.address_line2 ?? "",
    city: profile.city ?? "",
    county: profile.county ?? "",
    postal_code: profile.postal_code ?? "",
    country: profile.country ?? "",
  });

  const save = async () => {
    setSaving(true);
    try {
      const { error } = await supabase.rpc("update_own_employee_personal" as any, { patch: form });
      if (error) throw error;
      toast.success("Personal details updated.");
      onSaved();
    } catch (e: any) {
      toast.error(e?.message ?? "Could not update personal details.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            <Phone className="h-4 w-4" /> Personal contact
          </CardTitle>
          <CardDescription>Your own contact details. HR is notified when these change.</CardDescription>
        </div>
        <Badge className="gap-1">You manage this</Badge>
      </CardHeader>
      <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <TextField label="Personal phone" value={form.personal_phone} onChange={(v) => setForm({ ...form, personal_phone: v })} />
        <TextField label="Alternate phone" value={form.phone} onChange={(v) => setForm({ ...form, phone: v })} />
        <div>
          <Label className="text-xs text-muted-foreground">Marital status</Label>
          <Select value={form.marital_status || "unset"} onValueChange={(v) => setForm({ ...form, marital_status: v === "unset" ? "" : v })}>
            <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="unset">—</SelectItem>
              <SelectItem value="single">Single</SelectItem>
              <SelectItem value="married">Married</SelectItem>
              <SelectItem value="divorced">Divorced</SelectItem>
              <SelectItem value="widowed">Widowed</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div />
        <div className="md:col-span-2">
          <Separator className="my-1" />
          <p className="text-xs text-muted-foreground flex items-center gap-1 mt-2 mb-3">
            <MapPin className="h-3 w-3" /> Home address
          </p>
        </div>
        <TextField label="Address line 1" value={form.address_line1} onChange={(v) => setForm({ ...form, address_line1: v })} />
        <TextField label="Address line 2" value={form.address_line2} onChange={(v) => setForm({ ...form, address_line2: v })} />
        <TextField label="City" value={form.city} onChange={(v) => setForm({ ...form, city: v })} />
        <TextField label="County / State" value={form.county} onChange={(v) => setForm({ ...form, county: v })} />
        <TextField label="Postal code" value={form.postal_code} onChange={(v) => setForm({ ...form, postal_code: v })} />
        <TextField label="Country" value={form.country} onChange={(v) => setForm({ ...form, country: v })} />
        <div className="md:col-span-2 flex justify-end">
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Save personal details
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 3. Emergency contact
// ---------------------------------------------------------------------------

function EmergencyContactCard({ profile, onSaved }: { profile: MyProfile; onSaved: () => void }) {
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    emergency_contact_name: profile.emergency_contact_name ?? "",
    emergency_contact_phone: profile.emergency_contact_phone ?? "",
    emergency_contact_relationship: profile.emergency_contact_relationship ?? "",
  });

  const save = async () => {
    setSaving(true);
    try {
      const { error } = await supabase.rpc("update_own_employee_personal" as any, { patch: form });
      if (error) throw error;
      toast.success("Emergency contact updated.");
      onSaved();
    } catch (e: any) {
      toast.error(e?.message ?? "Could not update emergency contact.");
    } finally { setSaving(false); }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            <HeartPulse className="h-4 w-4" /> Emergency contact
          </CardTitle>
          <CardDescription>Who should we call if something happens at work.</CardDescription>
        </div>
        <Badge className="gap-1">You manage this</Badge>
      </CardHeader>
      <CardContent className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <TextField label="Full name" value={form.emergency_contact_name} onChange={(v) => setForm({ ...form, emergency_contact_name: v })} />
        <TextField label="Phone" value={form.emergency_contact_phone} onChange={(v) => setForm({ ...form, emergency_contact_phone: v })} />
        <TextField label="Relationship" value={form.emergency_contact_relationship} onChange={(v) => setForm({ ...form, emergency_contact_relationship: v })} />
        <div className="md:col-span-3 flex justify-end">
          <Button onClick={save} disabled={saving} variant="outline">
            {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Save emergency contact
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 4. Bank & IDs (masked; changes require HR approval)
// ---------------------------------------------------------------------------

function BankAndIdCard({ profile }: { profile: MyProfile }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="text-base flex items-center gap-2">
            <Landmark className="h-4 w-4" /> Bank &amp; identifiers
          </CardTitle>
          <CardDescription>Sensitive fields. Changes require HR approval before the next payroll run.</CardDescription>
        </div>
        <Badge variant="secondary" className="gap-1"><ShieldCheck className="h-3 w-3" /> HR approval required</Badge>
      </CardHeader>
      <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3 text-sm">
        <Field label="Bank" value={profile.bank_name} />
        <Field label="Branch" value={profile.bank_branch} />
        <Field label="Bank account" value={profile.bank_account_masked ?? "—"} />
        <Field label="National ID" value={profile.national_id_masked ?? "—"} />
        <div className="md:col-span-2 pt-2">
          <ChangeRequestDialog defaultField="bank_account_number" label="Request bank / ID change" />
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Shared dialog: submit change request
// ---------------------------------------------------------------------------

function ChangeRequestDialog({
  defaultField,
  label = "Request a correction",
}: { defaultField?: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [field, setField] = useState(defaultField ?? HR_CHANGE_REQUEST_FIELDS[0].key);
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!value.trim()) { toast.error("Please enter the new value."); return; }
    setSaving(true);
    try {
      // NOTE: supabase-js already JSON-encodes RPC args once. Passing the raw
      // trimmed string here yields a jsonb string like "Bob" (no double-encoding).
      // Previously JSON.stringify(value) produced jsonb "\"Bob\"" which surfaced
      // with quotes after the review RPC's `#>>'{}'` extraction.
      const { error } = await supabase.rpc("submit_profile_change_request" as any, {
        p_field_key: field,
        p_new_value: value.trim(),
        p_reason: reason || null,
      });
      if (error) throw error;
      toast.success("Change request submitted. HR will review it.");
      setOpen(false); setValue(""); setReason("");
    } catch (e: any) {
      toast.error(e?.message ?? "Could not submit request.");
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm"><Send className="h-3.5 w-3.5 mr-1.5" /> {label}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Request a profile change</DialogTitle>
          <DialogDescription>Your HR team will review this and apply it if approved.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Field to change</Label>
            <Select value={field} onValueChange={setField}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {HR_CHANGE_REQUEST_FIELDS.map((f) => (
                  <SelectItem key={f.key} value={f.key}>{f.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>New value</Label>
            <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="What should it be?" />
          </div>
          <div>
            <Label>Reason (optional)</Label>
            <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} placeholder="Why does this need to change?" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
            Submit request
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-sm">{value || "—"}</div>
    </div>
  );
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// My change requests — pending HR reviews submitted by this employee
// ---------------------------------------------------------------------------

function MyChangeRequestsStrip({ employeeId }: { employeeId: string }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["my-profile-change-requests", employeeId],
    enabled: !!employeeId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("employee_profile_change_requests" as any)
        .select("id, field_key, new_value, status, reason, created_at, review_note, reviewed_at")
        .eq("employee_id", employeeId)
        .in("status", ["pending", "rejected"])
        .order("created_at", { ascending: false })
        .limit(10);
      if (error) throw error;
      return (data ?? []) as unknown as Array<{
        id: string; field_key: string; new_value: any; status: string;
        reason: string | null; created_at: string; review_note: string | null; reviewed_at: string | null;
      }>;
    },
  });

  const cancel = async (id: string) => {
    const { error } = await supabase
      .from("employee_profile_change_requests" as any)
      .update({ status: "cancelled" })
      .eq("id", id);
    if (error) { toast.error(error.message); return; }
    toast.success("Request cancelled.");
    qc.invalidateQueries({ queryKey: ["my-profile-change-requests"] });
  };

  if (isLoading || !data || data.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Send className="h-4 w-4" /> My change requests
        </CardTitle>
        <CardDescription>Requests submitted to HR for review.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {data.map((r) => {
          const label = HR_CHANGE_REQUEST_FIELDS.find((f) => f.key === r.field_key)?.label ?? r.field_key;
          const newVal = typeof r.new_value === "string" ? r.new_value : JSON.stringify(r.new_value);
          return (
            <div key={r.id} className="flex items-start justify-between gap-3 border-b last:border-b-0 pb-2 last:pb-0">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{label}</span>
                  <Badge variant={r.status === "pending" ? "secondary" : "destructive"}>{r.status}</Badge>
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  Proposed: {newVal}
                </div>
                {r.reason && <div className="text-xs text-muted-foreground">Reason: {r.reason}</div>}
                {r.review_note && <div className="text-xs text-muted-foreground">HR note: {r.review_note}</div>}
              </div>
              {r.status === "pending" && (
                <Button size="sm" variant="ghost" onClick={() => cancel(r.id)}>Cancel</Button>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
