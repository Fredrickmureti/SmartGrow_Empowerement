// @ts-nocheck - Admin tables not in auto-generated types
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { usePlatformSettings } from "@/hooks/usePlatformSettings";
import {
  Mail,
  Send,
  Users,
  Building2,
  Loader2,
  AlertCircle,
  User,
} from "lucide-react";
import { AdminAIEmailAssistant } from "./AdminAIEmailAssistant";
import { fetchOwnerEmails } from "@/hooks/useOwnerEmails";
import { normalizeError } from "@/services/resilience";

interface Organization {
  id: string;
  name: string;
  email: string | null;
  slug: string;
  ownerEmail: string | null;
  resolvedEmail: string | null;
  emailSource: "org" | "owner" | null;
}

interface ComposeEmailTabProps {
  emailConfigured: boolean;
}

export function ComposeEmailTab({ emailConfigured }: ComposeEmailTabProps) {
  const { toast } = useToast();
  const { getSetting } = usePlatformSettings();
  
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSending, setIsSending] = useState(false);
  
  // Email form
  const [recipientType, setRecipientType] = useState<"all" | "selected" | "custom">("all");
  const [selectedOrgs, setSelectedOrgs] = useState<string[]>([]);
  const [customEmail, setCustomEmail] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [useHtml, setUseHtml] = useState(false);
  
  useEffect(() => {
    fetchOrganizations();
  }, []);

  const fetchOrganizations = async () => {
    try {
      const { data, error } = await supabase
        .from("organizations")
        .select("id, name, email, slug")
        .order("name");
      
      if (error) throw error;

      const orgIds = (data || []).map(o => o.id);
      const ownerEmails = await fetchOwnerEmails(orgIds);

      const enriched: Organization[] = (data || []).map(org => {
        const ownerEmail = ownerEmails[org.id] || null;
        const resolvedEmail = org.email || ownerEmail;
        return {
          ...org,
          ownerEmail,
          resolvedEmail,
          emailSource: org.email ? "org" : ownerEmail ? "owner" : null,
        };
      });

      setOrganizations(enriched);
    } catch (error) {
      console.error("Error fetching organizations:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const getRecipients = (): string[] => {
    switch (recipientType) {
      case "all":
        return organizations.filter(o => o.resolvedEmail).map(o => o.resolvedEmail as string);
      case "selected":
        return organizations
          .filter(o => selectedOrgs.includes(o.id) && o.resolvedEmail)
          .map(o => o.resolvedEmail as string);
      case "custom":
        return customEmail.split(",").map(e => e.trim()).filter(Boolean);
      default:
        return [];
    }
  };

  const handleSendEmail = async () => {
    const recipients = getRecipients();
    
    if (recipients.length === 0) {
      toast({
        title: "No recipients",
        description: "Please select at least one recipient with a valid email.",
        variant: "destructive",
      });
      return;
    }

    if (!subject.trim() || !body.trim()) {
      toast({
        title: "Missing content",
        description: "Please enter a subject and message body.",
        variant: "destructive",
      });
      return;
    }

    setIsSending(true);
    try {
      const { data, error } = await supabase.functions.invoke("send-admin-email", {
        body: {
          recipients,
          subject,
          body,
          isHtml: useHtml,
        },
      });

      if (error) throw error;

      // Log the sent email
      await (supabase.from as any)("platform_email_logs").insert({
        recipient_email: recipients.join(", "),
        subject,
        html_body: useHtml ? body : null,
        status: "sent",
        sent_at: new Date().toISOString(),
        metadata: { recipient_type: recipientType, recipient_count: recipients.length },
      });

      toast({
        title: "Email sent successfully",
        description: `Email delivered to ${recipients.length} recipient(s).`,
      });

      // Clear form
      setSubject("");
      setBody("");
      setSelectedOrgs([]);
      setCustomEmail("");
    } catch (error: any) {
      console.error("Error sending email:", error);
      toast({
        title: "Error sending email",
        description: normalizeError(error).message || "Failed to send email. Check email provider configuration.",
        variant: "destructive",
      });
    } finally {
      setIsSending(false);
    }
  };

  const toggleOrgSelection = (orgId: string) => {
    setSelectedOrgs(prev => 
      prev.includes(orgId) 
        ? prev.filter(id => id !== orgId)
        : [...prev, orgId]
    );
  };

  return (
    <>
      {!emailConfigured && (
        <Card className="border-orange-500/30 bg-orange-500/5 mb-6">
          <CardContent className="flex items-center gap-4 py-4">
            <AlertCircle className="h-5 w-5 text-orange-600" />
            <div>
              <p className="font-medium text-orange-700 dark:text-orange-400">
                Email provider not configured
              </p>
              <p className="text-sm text-orange-600 dark:text-orange-300">
                Please configure an email provider in Settings → Email before sending emails.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Compose Email */}
        <div className="lg:col-span-2 space-y-6">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Mail className="h-5 w-5" />
                    Compose Email
                  </CardTitle>
                  <CardDescription>
                    Send an email to organizations or specific addresses
                  </CardDescription>
                </div>
                <AdminAIEmailAssistant
                  currentSubject={subject}
                  currentBody={body}
                  isHtml={useHtml}
                  onSubjectUpdate={setSubject}
                  onBodyUpdate={setBody}
                  onHtmlToggle={setUseHtml}
                />
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Recipients */}
              <div className="space-y-4">
                <Label>Recipients</Label>
                <Select value={recipientType} onValueChange={(v: any) => setRecipientType(v)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                     <SelectItem value="all">
                      <div className="flex items-center gap-2">
                        <Users className="h-4 w-4" />
                        All Organizations ({organizations.filter(o => o.resolvedEmail).length})
                      </div>
                    </SelectItem>
                    <SelectItem value="selected">
                      <div className="flex items-center gap-2">
                        <Building2 className="h-4 w-4" />
                        Selected Organizations
                      </div>
                    </SelectItem>
                    <SelectItem value="custom">
                      <div className="flex items-center gap-2">
                        <Mail className="h-4 w-4" />
                        Custom Email Addresses
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>

                {recipientType === "selected" && (
                  <div className="border rounded-lg max-h-48 overflow-y-auto">
                    {organizations.map((org) => (
                      <div
                        key={org.id}
                        className={`flex items-center justify-between p-3 hover:bg-muted/50 cursor-pointer ${
                          selectedOrgs.includes(org.id) ? "bg-primary/5" : ""
                        }`}
                        onClick={() => toggleOrgSelection(org.id)}
                      >
                         <div>
                          <p className="font-medium text-sm">{org.name}</p>
                          <p className="text-xs text-muted-foreground flex items-center gap-1">
                            {org.resolvedEmail || "No email"}
                            {org.emailSource === "owner" && (
                              <Badge variant="outline" className="text-[10px] px-1 py-0 ml-1">
                                <User className="h-2.5 w-2.5 mr-0.5" />
                                owner
                              </Badge>
                            )}
                          </p>
                        </div>
                        <input
                          type="checkbox"
                          checked={selectedOrgs.includes(org.id)}
                          onChange={() => toggleOrgSelection(org.id)}
                          className="h-4 w-4"
                        />
                      </div>
                    ))}
                  </div>
                )}

                {recipientType === "custom" && (
                  <div className="space-y-2">
                    <Input
                      placeholder="email1@example.com, email2@example.com"
                      value={customEmail}
                      onChange={(e) => setCustomEmail(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Separate multiple emails with commas
                    </p>
                  </div>
                )}
              </div>

              {/* Subject */}
              <div className="space-y-2">
                <Label htmlFor="subject">Subject</Label>
                <Input
                  id="subject"
                  placeholder="Enter email subject..."
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                />
              </div>

              {/* Body */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="body">Message</Label>
                  <div className="flex items-center gap-2">
                    <Label htmlFor="html-mode" className="text-xs text-muted-foreground">
                      HTML Mode
                    </Label>
                    <Switch
                      id="html-mode"
                      checked={useHtml}
                      onCheckedChange={setUseHtml}
                    />
                  </div>
                </div>
                <Textarea
                  id="body"
                  placeholder={useHtml ? "<h1>Hello!</h1><p>Your message here...</p>" : "Enter your message..."}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={12}
                  className="font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  {useHtml ? "Write HTML for rich formatting" : "Plain text email"}
                </p>
              </div>

              {/* Send Button */}
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  {getRecipients().length} recipient(s) selected
                </p>
                <Button 
                  onClick={handleSendEmail} 
                  disabled={isSending || !emailConfigured}
                  size="lg"
                >
                  {isSending ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Sending...
                    </>
                  ) : (
                    <>
                      <Send className="h-4 w-4 mr-2" />
                      Send Email
                    </>
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Quick Stats */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Email Configuration</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Provider</span>
                <Badge variant={emailConfigured ? "default" : "secondary"}>
                  {getSetting("email_provider") || "Not configured"}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">From Email</span>
                <span className="text-sm">{getSetting("resend_from_email") || "—"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Reply-To</span>
                <span className="text-sm">{getSetting("platform_admin_reply_to_email") || "—"}</span>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Organizations</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Total</span>
                <span className="font-medium">{organizations.length}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Reachable</span>
                <span className="font-medium text-green-600">
                  {organizations.filter(o => o.resolvedEmail).length}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">No Email</span>
                <span className="font-medium text-orange-600">
                  {organizations.filter(o => !o.resolvedEmail).length}
                </span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
