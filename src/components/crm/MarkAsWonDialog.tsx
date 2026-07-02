import { useState } from "react";
import { WorkflowSheet, WorkflowSheetSection } from "@/components/workflow/WorkflowSheet";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Loader2, Trophy, UserPlus, FileText, ShoppingCart, FolderKanban } from "lucide-react";
import { Lead } from "@/hooks/crm/useLeads";
import { useCurrency } from "@/hooks/useCurrency";

interface MarkAsWonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  lead: Lead;
  onConfirm: (options: {
    createContact: boolean;
    create: { estimate: boolean; salesOrder: boolean; project: boolean };
  }) => Promise<void>;
}

export function MarkAsWonDialog({
  open,
  onOpenChange,
  lead,
  onConfirm,
}: MarkAsWonDialogProps) {
  const { formatCurrency, baseCurrency } = useCurrency();
  const [createContact, setCreateContact] = useState(true);
  const [estimate, setEstimate] = useState(false);
  const [salesOrder, setSalesOrder] = useState(true);
  const [project, setProject] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const hasContact = !!lead.contact_id;

  const handleConfirm = async () => {
    setIsSubmitting(true);
    try {
      await onConfirm({
        createContact: !hasContact && createContact,
        create: { estimate, salesOrder, project },
      });
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to mark as won:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const row = (opts: {
    id: string;
    checked: boolean;
    onChange: (v: boolean) => void;
    icon: React.ReactNode;
    title: string;
    hint: string;
  }) => (
    <div
      className="flex items-start space-x-3 rounded-lg border p-4 hover:bg-muted/50 cursor-pointer"
      onClick={() => opts.onChange(!opts.checked)}
    >
      <Checkbox id={opts.id} checked={opts.checked} onCheckedChange={(c) => opts.onChange(!!c)} />
      <div className="flex items-start gap-2 flex-1">
        {opts.icon}
        <div>
          <Label htmlFor={opts.id} className="cursor-pointer">{opts.title}</Label>
          <p className="text-xs text-muted-foreground">{opts.hint}</p>
        </div>
      </div>
    </div>
  );

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <Trophy className="h-5 w-5 text-green-600" />
          Congratulations! 🎉
        </span>
      }
      description={
        <>
          You're about to mark "{lead.name}" as won
          {lead.expected_revenue && (
            <span className="font-medium text-foreground">
              {" "}for {formatCurrency(lead.expected_revenue, baseCurrency)}
            </span>
          )}
          . Pick the follow-up documents to create — Sales Order + Project will be cross-linked automatically.
        </>
      }
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={isSubmitting}
            className="bg-green-600 hover:bg-green-700"
          >
            {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            <Trophy className="h-4 w-4 mr-2" />
            Mark as Won
          </Button>
        </>
      }
    >
      <WorkflowSheetSection number={1} title="Customer record">
        {!hasContact && (lead.contact_name || lead.email) ? (
          <div className="flex items-start space-x-3 rounded-lg border p-4 bg-muted/30">
            <Checkbox
              id="create-contact"
              checked={createContact}
              onCheckedChange={(checked) => setCreateContact(!!checked)}
            />
            <div className="space-y-1">
              <Label htmlFor="create-contact" className="flex items-center gap-2 cursor-pointer">
                <UserPlus className="h-4 w-4" />
                Create Customer Record
              </Label>
              <p className="text-sm text-muted-foreground">
                Add {lead.contact_name || lead.email} to your contacts as a customer
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/30 rounded-lg p-3">
            <UserPlus className="h-4 w-4" />
            Customer record already exists
          </div>
        )}
      </WorkflowSheetSection>

      <WorkflowSheetSection number={2} title="Follow-up documents" subtitle="Generate downstream artifacts from this lead">
        {row({
          id: "want-estimate",
          checked: estimate,
          onChange: setEstimate,
          icon: <FileText className="h-4 w-4 text-blue-600" />,
          title: "Estimate / Quote",
          hint: "Send a formal quote first (line items copied from the lead)",
        })}
        {row({
          id: "want-so",
          checked: salesOrder,
          onChange: setSalesOrder,
          icon: <ShoppingCart className="h-4 w-4 text-primary" />,
          title: "Sales Order",
          hint: "Start fulfillment immediately (line items copied from the lead)",
        })}
        {row({
          id: "want-project",
          checked: project,
          onChange: setProject,
          icon: <FolderKanban className="h-4 w-4 text-violet-600" />,
          title: "Project",
          hint: "Kick off delivery work (auto-linked to the Sales Order when both are selected)",
        })}
      </WorkflowSheetSection>
    </WorkflowSheet>
  );
}
