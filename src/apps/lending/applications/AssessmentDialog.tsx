/**
 * Record a physical business assessment against an application (C5).
 *
 * The assessment is an attributable in-person visit — the officer who records
 * it is taken from the session, never chosen in the form. Affordability figures
 * are captured as observed facts; no scoring or decision happens here.
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  MF_ASSESSMENT_RECOMMENDATIONS,
  useMfApplicationAssessments,
  type MfAssessmentRecommendation,
  type MfLoanApplication,
} from "@/hooks/useMfApplications";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  application: MfLoanApplication | null;
}

const RECOMMENDATION_LABELS: Record<MfAssessmentRecommendation, string> = {
  recommend: "Recommend",
  refer: "Refer to credit committee",
  decline: "Decline",
};

export function AssessmentDialog({ open, onOpenChange, application }: Props) {
  const { assessments, isLoading, recordAssessment } = useMfApplicationAssessments(
    application?.id,
  );
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    visit_date: "",
    visit_location: "",
    business_verified: true,
    monthly_income: "",
    monthly_expenses: "",
    existing_obligations: "0",
    collateral_description: "",
    character_notes: "",
    recommended_amount: "",
    recommended_term_installments: "",
    recommendation: "recommend" as MfAssessmentRecommendation,
    notes: "",
  });

  useEffect(() => {
    if (!open || !application) return;
    setForm({
      visit_date: new Date().toISOString().slice(0, 10),
      visit_location: "",
      business_verified: true,
      monthly_income: "",
      monthly_expenses: "",
      existing_obligations: "0",
      collateral_description: "",
      character_notes: "",
      recommended_amount: String(application.requested_amount),
      recommended_term_installments: String(application.requested_term_installments),
      recommendation: "recommend",
      notes: "",
    });
  }, [open, application]);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const num = (v: string) => (v.trim() === "" ? 0 : Number(v));
  const optionalNum = (v: string) => (v.trim() === "" ? null : Number(v));

  const valid =
    !!application &&
    form.visit_date !== "" &&
    Number.isFinite(num(form.monthly_income)) &&
    Number.isFinite(num(form.monthly_expenses));

  const submit = async () => {
    if (!application || !valid) return;
    setSaving(true);
    try {
      await recordAssessment.mutateAsync({
        application_id: application.id,
        visit_date: form.visit_date,
        visit_location: form.visit_location.trim() || null,
        business_verified: form.business_verified,
        monthly_income: num(form.monthly_income),
        monthly_expenses: num(form.monthly_expenses),
        existing_obligations: num(form.existing_obligations),
        collateral_description: form.collateral_description.trim() || null,
        character_notes: form.character_notes.trim() || null,
        recommended_amount: optionalNum(form.recommended_amount),
        recommended_term_installments: optionalNum(form.recommended_term_installments),
        recommendation: form.recommendation,
        notes: form.notes.trim() || null,
      });
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Business assessment</DialogTitle>
          <DialogDescription>
            {application
              ? `Physical visit for ${application.application_number}. Recorded against your user.`
              : ""}
          </DialogDescription>
        </DialogHeader>

        {assessments.length > 0 && (
          <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
            {assessments.length} earlier assessment(s) on file — the most recent visit was on{" "}
            {assessments[0]?.visit_date}. Recording another adds to the history; nothing is
            overwritten.
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="visit_date">Visit date</Label>
            <Input
              id="visit_date"
              type="date"
              value={form.visit_date}
              onChange={(e) => set("visit_date", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="visit_location">Visit location</Label>
            <Input
              id="visit_location"
              value={form.visit_location}
              onChange={(e) => set("visit_location", e.target.value)}
              placeholder="Market stall, shop, home…"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="monthly_income">Monthly income</Label>
            <Input
              id="monthly_income"
              inputMode="decimal"
              value={form.monthly_income}
              onChange={(e) => set("monthly_income", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="monthly_expenses">Monthly expenses</Label>
            <Input
              id="monthly_expenses"
              inputMode="decimal"
              value={form.monthly_expenses}
              onChange={(e) => set("monthly_expenses", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="existing_obligations">Existing obligations</Label>
            <Input
              id="existing_obligations"
              inputMode="decimal"
              value={form.existing_obligations}
              onChange={(e) => set("existing_obligations", e.target.value)}
            />
          </div>
          <div className="flex items-center justify-between rounded-md border px-3 py-2">
            <Label htmlFor="business_verified" className="text-sm font-normal">
              Business physically verified
            </Label>
            <Switch
              id="business_verified"
              checked={form.business_verified}
              onCheckedChange={(v) => set("business_verified", v)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="recommended_amount">Recommended amount</Label>
            <Input
              id="recommended_amount"
              inputMode="decimal"
              value={form.recommended_amount}
              onChange={(e) => set("recommended_amount", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="recommended_term">Recommended installments</Label>
            <Input
              id="recommended_term"
              inputMode="numeric"
              value={form.recommended_term_installments}
              onChange={(e) => set("recommended_term_installments", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Recommendation</Label>
            <Select
              value={form.recommendation}
              onValueChange={(v) => set("recommendation", v as MfAssessmentRecommendation)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MF_ASSESSMENT_RECOMMENDATIONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {RECOMMENDATION_LABELS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="collateral_description">Collateral / security</Label>
            <Input
              id="collateral_description"
              value={form.collateral_description}
              onChange={(e) => set("collateral_description", e.target.value)}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="character_notes">Character and standing</Label>
            <Textarea
              id="character_notes"
              rows={2}
              value={form.character_notes}
              onChange={(e) => set("character_notes", e.target.value)}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="assessment_notes">Visit notes</Label>
            <Textarea
              id="assessment_notes"
              rows={3}
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!valid || saving || isLoading}>
            {saving ? "Recording…" : "Record assessment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default AssessmentDialog;
