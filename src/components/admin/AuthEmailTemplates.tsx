// @ts-nocheck - Admin tables not in auto-generated types
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "sonner";
import { 
  Copy, 
  Eye, 
  ExternalLink, 
  Mail, 
  UserPlus, 
  Wand2, 
  KeyRound, 
  AtSign,
  Check,
  Code
} from "lucide-react";
import { authEmailTemplates, AuthEmailTemplate } from "@/lib/authEmailTemplates";

const templateIcons: Record<string, React.ReactNode> = {
  'confirm-signup': <Mail className="h-5 w-5" />,
  'invite-user': <UserPlus className="h-5 w-5" />,
  'magic-link': <Wand2 className="h-5 w-5" />,
  'change-email': <AtSign className="h-5 w-5" />,
  'reset-password': <KeyRound className="h-5 w-5" />,
};

export function AuthEmailTemplates() {
  const [selectedTemplate, setSelectedTemplate] = useState<AuthEmailTemplate | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopyHtml = async (template: AuthEmailTemplate) => {
    try {
      await navigator.clipboard.writeText(template.html);
      setCopiedId(template.id);
      toast.success(`${template.name} template copied to clipboard!`);
      setTimeout(() => setCopiedId(null), 2000);
    } catch (error) {
      toast.error("Failed to copy template");
    }
  };

  const handleCopySubject = async (template: AuthEmailTemplate) => {
    try {
      await navigator.clipboard.writeText(template.subject);
      toast.success("Subject line copied!");
    } catch (error) {
      toast.error("Failed to copy subject");
    }
  };

  const openSupabaseTemplates = () => {
    window.open(
      "https://supabase.com/dashboard/project/jkszmrroyjfdwokbkzis/auth/templates",
      "_blank"
    );
  };

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg sm:text-2xl font-bold tracking-tight">Auth Email Templates</h2>
          <p className="text-xs sm:text-sm text-muted-foreground">
            Beautiful, branded email templates for Supabase Authentication
          </p>
        </div>
        <Button onClick={openSupabaseTemplates} variant="outline" size="sm" className="gap-2 self-start sm:self-auto">
          <ExternalLink className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
          <span className="text-xs sm:text-sm">Open Supabase Templates</span>
        </Button>
      </div>

      {/* Instructions Card */}
      <Card className="border-primary/20 bg-primary/5">
        <CardContent className="p-4 sm:pt-6">
          <div className="flex gap-3 sm:gap-4">
            <div className="flex-shrink-0 hidden sm:block">
              <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                <Mail className="h-5 w-5 text-primary" />
              </div>
            </div>
            <div className="space-y-1">
              <h3 className="text-sm sm:text-base font-semibold">How to use these templates</h3>
              <ol className="text-xs sm:text-sm text-muted-foreground space-y-0.5 sm:space-y-1 list-decimal list-inside">
                <li>Click "Copy HTML" on any template below</li>
                <li>Go to Supabase Dashboard → Authentication → Email Templates</li>
                <li>Select the corresponding template type</li>
                <li>Paste the HTML into the "Body" field</li>
                <li>Update the "Subject" field (also provided below)</li>
                <li>Save changes</li>
              </ol>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Template Grid */}
      <div className="grid gap-3 sm:gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
        {authEmailTemplates.map((template) => (
          <Card key={template.id} className="overflow-hidden hover:shadow-lg transition-shadow">
            <CardHeader className="p-3 sm:p-6 pb-2 sm:pb-3">
              <div className="flex items-start gap-2.5 sm:gap-3">
                <div className="h-8 w-8 sm:h-10 sm:w-10 rounded-lg bg-gradient-to-br from-primary to-purple-600 flex items-center justify-center text-white shrink-0 [&_svg]:h-4 [&_svg]:w-4 sm:[&_svg]:h-5 sm:[&_svg]:w-5">
                  {templateIcons[template.id]}
                </div>
                <div className="min-w-0">
                  <CardTitle className="text-sm sm:text-base">{template.name}</CardTitle>
                  <CardDescription className="text-xs mt-0.5 line-clamp-2">
                    {template.description}
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-3 sm:p-6 pt-0 sm:pt-0 space-y-3 sm:space-y-4">
              {/* Subject Line */}
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Subject Line</label>
                <div className="flex items-center gap-1.5">
                  <code className="flex-1 text-xs bg-muted px-2 py-1.5 rounded truncate block">
                    {template.subject}
                  </code>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() => handleCopySubject(template)}
                  >
                    <Copy className="h-3 w-3" />
                  </Button>
                </div>
              </div>

              {/* Variables */}
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Variables Used</label>
                <div className="flex flex-wrap gap-1">
                  {template.variables.map((variable) => (
                    <Badge key={variable} variant="secondary" className="text-[10px] sm:text-xs font-mono px-1.5 py-0">
                      {variable}
                    </Badge>
                  ))}
                </div>
              </div>

              {/* Actions */}
              <div className="flex flex-wrap gap-1.5 sm:gap-2 pt-1 sm:pt-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 min-w-[70px] gap-1 text-xs h-8"
                  onClick={() => {
                    setSelectedTemplate(template);
                    setShowPreview(true);
                  }}
                >
                  <Eye className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
                  Preview
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 min-w-[70px] gap-1 text-xs h-8"
                  onClick={() => {
                    setSelectedTemplate(template);
                    setShowCode(true);
                  }}
                >
                  <Code className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
                  Code
                </Button>
                <Button
                  size="sm"
                  className="flex-1 min-w-[80px] gap-1 text-xs h-8"
                  onClick={() => handleCopyHtml(template)}
                >
                  {copiedId === template.id ? (
                    <>
                      <Check className="h-3 w-3" />
                      Copied!
                    </>
                  ) : (
                    <>
                      <Copy className="h-3 w-3" />
                      Copy
                    </>
                  )}
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Preview Dialog */}
      <Dialog open={showPreview} onOpenChange={setShowPreview}>
        <DialogContent className="w-[95vw] max-w-4xl h-[80vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm sm:text-base">
              {selectedTemplate && templateIcons[selectedTemplate.id]}
              {selectedTemplate?.name} Preview
            </DialogTitle>
            <DialogDescription className="text-xs sm:text-sm">
              This is how the email will appear to recipients
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-hidden rounded-lg border bg-muted/30">
            <iframe
              srcDoc={selectedTemplate?.html}
              className="w-full h-full min-h-[400px] sm:min-h-[500px]"
              title="Email Preview"
              sandbox="allow-same-origin"
            />
          </div>
        </DialogContent>
      </Dialog>

      {/* Code Dialog */}
      <Dialog open={showCode} onOpenChange={setShowCode}>
        <DialogContent className="w-[95vw] max-w-4xl h-[80vh]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-sm sm:text-base">
              <Code className="h-4 w-4 sm:h-5 sm:w-5" />
              {selectedTemplate?.name} HTML Code
            </DialogTitle>
            <DialogDescription className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-xs sm:text-sm">Copy this HTML and paste it into Supabase</span>
              <Button
                size="sm"
                className="gap-1.5 self-start sm:self-auto text-xs"
                onClick={() => selectedTemplate && handleCopyHtml(selectedTemplate)}
              >
                <Copy className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
                Copy HTML
              </Button>
            </DialogDescription>
          </DialogHeader>
          <ScrollArea className="flex-1 rounded-lg border bg-zinc-950 p-4">
            <pre className="text-xs text-zinc-300 whitespace-pre-wrap font-mono">
              {selectedTemplate?.html}
            </pre>
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}
