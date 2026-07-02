/**
 * TalentFormShell — thin wrapper around WorkflowSheet so every Talent
 * (HR → Talent) create/edit experience opens in the same right-side
 * enterprise sheet, sized and titled consistently. Mirrors the
 * LocalizationFormShell / PayrollFormShell pattern so future Talent
 * editors don't re-derive the chrome.
 */
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import {
  WorkflowSheet,
  type WorkflowSheetSize,
} from "@/components/workflow/WorkflowSheet";

export type TalentEntity =
  | "cycle"
  | "goal"
  | "review"
  | "review-template"
  | "review-section"
  | "review-question"
  | "competency"
  | "competency-scale"
  | "development-plan"
  | "development-plan-item"
  | "development-plan-suggest"
  | "succession-plan"
  | "successor"
  | "talent-pool"
  | "talent-pool-member"
  | "nine-box-rating"
  | "learning-path"
  | "learning-path-course"
  | "quiz"
  | "quiz-question"
  | "feedback"
  | "calibration-session"
  | "calibration-adjustment";

const META: Record<
  TalentEntity,
  { create: string; edit: string; description: string; size: WorkflowSheetSize }
> = {
  cycle: {
    create: "New performance cycle",
    edit: "Edit performance cycle",
    description:
      "A cycle is the container for goals, reviews, and calibration in a period. Set the window and optional phase deadlines.",
    size: "lg",
  },
  goal: {
    create: "New goal",
    edit: "Edit goal",
    description:
      "Capture what success looks like. Goals can be cascaded, weighted, and rolled into the review at calibration time.",
    size: "lg",
  },
  review: {
    create: "New review",
    edit: "Edit review",
    description:
      "Open a review for the selected employee in the active cycle. Reviewers and template come from the cycle defaults.",
    size: "lg",
  },
  "review-template": {
    create: "New review template",
    edit: "Edit review template",
    description:
      "Design the questionnaire reviewers will see. Sections group related questions; questions drive the rating model.",
    size: "xl",
  },
  "review-section": {
    create: "Add section",
    edit: "Edit section",
    description: "Group related questions under a single heading.",
    size: "md",
  },
  "review-question": {
    create: "Add question",
    edit: "Edit question",
    description: "Configure the prompt, answer type, and weighting.",
    size: "md",
  },
  competency: {
    create: "New competency",
    edit: "Edit competency",
    description:
      "Competencies anchor reviews and development plans to the behaviours the business expects.",
    size: "lg",
  },
  "competency-scale": {
    create: "New scale",
    edit: "Edit scale",
    description: "Define the levels reviewers will pick from.",
    size: "md",
  },
  "development-plan": {
    create: "New development plan",
    edit: "Edit development plan",
    description:
      "Plan the next horizon for this employee — goals, learning, mentoring, and stretch assignments.",
    size: "lg",
  },
  "development-plan-item": {
    create: "Add plan item",
    edit: "Edit plan item",
    description: "One actionable step in the development plan.",
    size: "md",
  },
  "development-plan-suggest": {
    create: "Suggested actions",
    edit: "Suggested actions",
    description: "Pick which suggestions to add to the plan.",
    size: "lg",
  },
  "succession-plan": {
    create: "New succession plan",
    edit: "Edit succession plan",
    description:
      "Identify the role at risk and the readiness window — successors are added below.",
    size: "lg",
  },
  successor: {
    create: "Add successor",
    edit: "Edit successor",
    description: "Nominate a candidate and capture their readiness and risk.",
    size: "md",
  },
  "talent-pool": {
    create: "New talent pool",
    edit: "Edit talent pool",
    description:
      "Curate a strategic grouping — High Potentials, Retention Risks, Leadership bench.",
    size: "lg",
  },
  "talent-pool-member": {
    create: "Add to pool",
    edit: "Edit pool member",
    description: "Add an employee to this talent pool with optional readiness.",
    size: "md",
  },
  "nine-box-rating": {
    create: "Rate potential",
    edit: "Edit potential rating",
    description:
      "Combine performance with potential to place this employee on the 9-box grid.",
    size: "md",
  },
  "learning-path": {
    create: "New learning path",
    edit: "Edit learning path",
    description:
      "A learning path bundles courses into a sequence with an outcome and audience.",
    size: "lg",
  },
  "learning-path-course": {
    create: "Add course to path",
    edit: "Edit path course",
    description: "Pick the course and position it in the sequence.",
    size: "md",
  },
  quiz: {
    create: "New quiz",
    edit: "Edit quiz",
    description:
      "Quizzes attach to a course and measure comprehension. Configure passing score and attempt limits.",
    size: "lg",
  },
  "quiz-question": {
    create: "Add question",
    edit: "Edit question",
    description: "Set the prompt, answer options, and the correct choice.",
    size: "md",
  },
  feedback: {
    create: "Share feedback",
    edit: "Edit feedback",
    description:
      "Continuous feedback flows to the recipient and into their next review. Kudos are visible across the team.",
    size: "lg",
  },
  "calibration-session": {
    create: "New calibration session",
    edit: "Edit calibration session",
    description:
      "Pick the cycle, scope, and panel. Adjustments captured here update reviews after sign-off.",
    size: "xl",
  },
  "calibration-adjustment": {
    create: "Calibration adjustment",
    edit: "Edit adjustment",
    description: "Move the calibrated rating and capture the rationale.",
    size: "md",
  },
};

export interface TalentFormShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entity: TalentEntity;
  mode?: "create" | "edit";
  /** Override the default title (e.g. include the entity name being edited). */
  title?: ReactNode;
  /** Override the default subtitle. */
  description?: ReactNode;
  size?: WorkflowSheetSize;
  busy?: boolean;
  /** Submit handler — wired to a form when present so Enter submits. */
  onSubmit?: () => void;
  /** Submit button label. */
  submitLabel?: ReactNode;
  /** Disable submit (validation errors, busy, etc.). */
  submitDisabled?: boolean;
  /** Hide the default footer when the editor renders its own actions. */
  hideFooter?: boolean;
  /** Replace the footer entirely. */
  footer?: ReactNode;
  children: ReactNode;
}

export function TalentFormShell({
  open,
  onOpenChange,
  entity,
  mode = "create",
  title,
  description,
  size,
  busy,
  onSubmit,
  submitLabel,
  submitDisabled,
  hideFooter,
  footer,
  children,
}: TalentFormShellProps) {
  const meta = META[entity];
  const resolvedTitle = title ?? (mode === "edit" ? meta.edit : meta.create);
  const resolvedDescription = description ?? meta.description;
  const resolvedSize = size ?? meta.size;

  const defaultFooter =
    onSubmit && !hideFooter ? (
      <>
        <Button
          type="button"
          variant="ghost"
          onClick={() => onOpenChange(false)}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={submitDisabled || busy}>
          {busy && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
          {submitLabel ?? (mode === "edit" ? "Save" : "Create")}
        </Button>
      </>
    ) : (
      footer
    );

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={onOpenChange}
      title={resolvedTitle}
      description={resolvedDescription}
      size={resolvedSize}
      onSubmit={
        onSubmit
          ? (e) => {
              e.preventDefault();
              if (!submitDisabled && !busy) onSubmit();
            }
          : undefined
      }
      footer={hideFooter ? undefined : defaultFooter}
    >
      {children}
    </WorkflowSheet>
  );
}
