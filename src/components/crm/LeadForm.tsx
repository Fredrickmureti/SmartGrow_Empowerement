import { useState, useEffect, useMemo } from "react";
import { WorkflowSheet, WorkflowSheetSection, WorkflowSheetGrid, WorkflowField } from "@/components/workflow/WorkflowSheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CalendarIcon, Star, Search, X } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { useLeads, useCRMStages } from "@/hooks/crm";
import { useContactsPaginated } from "@/hooks/useContactsPaginated";
import { CustomFieldsSection } from "@/components/studio/CustomFieldsSection";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranch } from "@/contexts/BranchContext";

interface LeadFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultContactId?: string;
  defaultContactName?: string;
}

export function LeadForm({ open, onOpenChange, defaultContactId, defaultContactName }: LeadFormProps) {
  const { createLead } = useLeads();
  const { stages } = useCRMStages();
  const { contacts } = useContactsPaginated({});
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { branches, currentBranch, hasMultipleBranches } = useBranch();

  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [contactSearch, setContactSearch] = useState("");
  const [name, setName] = useState("");
  const [contactName, setContactName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [expectedRevenue, setExpectedRevenue] = useState("");
  const [probability, setProbability] = useState("50");
  const [expectedCloseDate, setExpectedCloseDate] = useState<Date>();
  const [stageId, setStageId] = useState("");
  const [branchId, setBranchId] = useState<string>("");
  const [priority, setPriority] = useState(1);
  const [source, setSource] = useState("");
  const [description, setDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Prefill from defaultContactId when dialog opens
  useEffect(() => {
    if (open && defaultContactId) {
      const contact = contacts.find(c => c.id === defaultContactId);
      if (contact) {
        handleSelectContact(contact);
      } else if (defaultContactName) {
        setSelectedContactId(defaultContactId);
        setContactName(defaultContactName);
      }
    }
  }, [open, defaultContactId, contacts]);

  useEffect(() => {
    if (stages.length > 0 && !stageId) {
      setStageId(stages[0].id);
    }
  }, [stages, stageId]);

  // Default the owning branch to the active workspace branch.
  useEffect(() => {
    if (!branchId && currentBranch?.id) setBranchId(currentBranch.id);
  }, [currentBranch?.id, branchId]);



  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name) return;

    setIsSubmitting(true);
    try {
      let companyContactId: string | null = null;
      const trimmedCompany = companyName.trim();
      if (trimmedCompany && currentOrg?.id && currentBusiness?.id) {
        const { data: ensured, error: ensureErr } = await supabase.rpc(
          "ensure_company_contact",
          {
            p_org_id: currentOrg.id,
            p_business_id: currentBusiness.id,
            p_name: trimmedCompany,
          },
        );
        if (!ensureErr && typeof ensured === "string") {
          companyContactId = ensured;
        }
      }

      await createLead({
        name,
        contact_name: contactName || undefined,
        contact_id: selectedContactId || undefined,
        email: email || undefined,
        phone: phone || undefined,
        company_contact_id: companyContactId || undefined,
        expected_revenue: expectedRevenue ? parseFloat(expectedRevenue) : undefined,
        probability: parseInt(probability),
        expected_close_date: expectedCloseDate ? format(expectedCloseDate, "yyyy-MM-dd") : undefined,
        stage_id: stageId || (stages[0]?.id),
        priority,
        source: source || undefined,
        description: description || undefined,
        type: "lead",
      });
      onOpenChange(false);
      resetForm();
    } catch (error) {
      console.error("Error creating lead:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const resetForm = () => {
    setName("");
    setContactName("");
    setEmail("");
    setPhone("");
    setCompanyName("");
    setExpectedRevenue("");
    setProbability("50");
    setExpectedCloseDate(undefined);
    setStageId("");
    setPriority(1);
    setSource("");
    setDescription("");
    setSelectedContactId(null);
    setContactSearch("");
  };

  const filteredContacts = useMemo(() => {
    if (!contactSearch) return [];
    const q = contactSearch.toLowerCase();
    return contacts.filter(c =>
      c.name.toLowerCase().includes(q) ||
      c.email?.toLowerCase().includes(q) ||
      c.company?.toLowerCase().includes(q)
    ).slice(0, 5);
  }, [contacts, contactSearch]);

  const handleSelectContact = (contact: any) => {
    setSelectedContactId(contact.id);
    setContactName(contact.name);
    setEmail(contact.email || "");
    setPhone(contact.phone || "");
    setCompanyName(contact.company || "");
    setContactSearch("");
  };

  const handleClearContact = () => {
    setSelectedContactId(null);
    setContactName("");
    setEmail("");
    setPhone("");
    setCompanyName("");
  };

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
      title="Create Lead"
      description="Add a new lead to your sales pipeline."
      onSubmit={handleSubmit}
      footer={
        <>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting || !name}>
            {isSubmitting ? "Creating..." : "Create Lead"}
          </Button>
        </>
      }
    >
      <WorkflowSheetSection number={1} title="Identity" subtitle="Who and what this opportunity is about">
        <WorkflowField label="Lead Name" htmlFor="name" required>
          <Input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Website Redesign Project"
            required
          />
        </WorkflowField>

        <WorkflowField label="Link to Existing Contact">
          {selectedContactId ? (
            <div className="flex items-center gap-2 p-2 border rounded-md bg-muted/50">
              <span className="text-sm font-medium flex-1">{contactName}</span>
              <Button type="button" variant="ghost" size="icon" className="h-6 w-6" onClick={handleClearContact}>
                <X className="h-3 w-3" />
              </Button>
            </div>
          ) : (
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search existing contacts..."
                value={contactSearch}
                onChange={(e) => setContactSearch(e.target.value)}
                className="pl-9"
              />
              {filteredContacts.length > 0 && (
                <div className="absolute z-50 w-full mt-1 border rounded-md bg-popover shadow-md">
                  {filteredContacts.map(c => (
                    <button
                      key={c.id}
                      type="button"
                      className="w-full text-left px-3 py-2 text-sm hover:bg-muted/50 flex items-center justify-between"
                      onClick={() => handleSelectContact(c)}
                    >
                      <span className="font-medium">{c.name}</span>
                      <span className="text-xs text-muted-foreground">{c.company || c.email || ""}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </WorkflowField>

        <WorkflowSheetGrid>
          <WorkflowField label="Contact Name" htmlFor="contact">
            <Input
              id="contact"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              placeholder="John Doe"
              disabled={!!selectedContactId}
            />
          </WorkflowField>
          <WorkflowField label="Company" htmlFor="company">
            <Input
              id="company"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              placeholder="Acme Inc."
              disabled={!!selectedContactId}
            />
          </WorkflowField>
          <WorkflowField label="Email" htmlFor="email">
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="john@example.com"
              disabled={!!selectedContactId}
            />
          </WorkflowField>
          <WorkflowField label="Phone" htmlFor="phone">
            <Input
              id="phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+1 234 567 890"
              disabled={!!selectedContactId}
            />
          </WorkflowField>
        </WorkflowSheetGrid>
      </WorkflowSheetSection>

      <WorkflowSheetSection number={2} title="Pipeline" subtitle="Stage, ownership, and timing">
        <WorkflowSheetGrid>
          <WorkflowField label="Stage" htmlFor="stage">
            <Select value={stageId} onValueChange={setStageId}>
              <SelectTrigger>
                <SelectValue placeholder="Select stage" />
              </SelectTrigger>
              <SelectContent>
                {stages.map((stage) => (
                  <SelectItem key={stage.id} value={stage.id}>
                    <div className="flex items-center gap-2">
                      <div
                        className="w-2 h-2 rounded-full"
                        style={{ backgroundColor: stage.color || "#6b7280" }}
                      />
                      {stage.name}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </WorkflowField>

          <WorkflowField label="Source" htmlFor="source">
            <Select value={source} onValueChange={setSource}>
              <SelectTrigger>
                <SelectValue placeholder="Select source" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="website">Website</SelectItem>
                <SelectItem value="referral">Referral</SelectItem>
                <SelectItem value="cold_call">Cold Call</SelectItem>
                <SelectItem value="trade_show">Trade Show</SelectItem>
                <SelectItem value="social_media">Social Media</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </WorkflowField>

          <WorkflowField label="Expected Close Date">
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    "w-full justify-start text-left font-normal",
                    !expectedCloseDate && "text-muted-foreground"
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {expectedCloseDate ? format(expectedCloseDate, "PPP") : "Pick a date"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={expectedCloseDate}
                  onSelect={setExpectedCloseDate}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
          </WorkflowField>

          <WorkflowField label="Priority">
            <div className="flex gap-1">
              {[1, 2, 3].map((p) => (
                <Button
                  key={p}
                  type="button"
                  variant={priority >= p ? "default" : "outline"}
                  size="icon"
                  onClick={() => setPriority(p)}
                >
                  <Star className={cn("h-4 w-4", priority >= p && "fill-current")} />
                </Button>
              ))}
            </div>
          </WorkflowField>
        </WorkflowSheetGrid>
      </WorkflowSheetSection>

      <WorkflowSheetSection number={3} title="Commercial" subtitle="Revenue and probability">
        <WorkflowSheetGrid>
          <WorkflowField label="Expected Revenue" htmlFor="revenue">
            <Input
              id="revenue"
              type="number"
              value={expectedRevenue}
              onChange={(e) => setExpectedRevenue(e.target.value)}
              placeholder="10000"
            />
          </WorkflowField>
          <WorkflowField label="Probability (%)" htmlFor="probability">
            <Select value={probability} onValueChange={setProbability}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="10">10%</SelectItem>
                <SelectItem value="25">25%</SelectItem>
                <SelectItem value="50">50%</SelectItem>
                <SelectItem value="75">75%</SelectItem>
                <SelectItem value="90">90%</SelectItem>
              </SelectContent>
            </Select>
          </WorkflowField>
        </WorkflowSheetGrid>
      </WorkflowSheetSection>

      <WorkflowSheetSection number={4} title="Description & custom fields">
        <WorkflowField label="Description" htmlFor="description">
          <Textarea
            id="description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Add notes about this lead..."
            rows={3}
          />
        </WorkflowField>

        <CustomFieldsSection
          entityType="crm_lead"
          entityId={null}
          formValues={{ name, contactName, email, phone, companyName, expectedRevenue, probability, stageId, priority, source, description }}
          disabled={isSubmitting}
        />
      </WorkflowSheetSection>
    </WorkflowSheet>
  );
}
