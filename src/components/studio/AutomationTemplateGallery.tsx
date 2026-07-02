import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { 
  Sparkles, 
  Check, 
  Loader2,
  TrendingUp,
  ShoppingCart,
  Package,
  Calculator,
  Users,
  Boxes,
} from "lucide-react";
import { 
  automationTemplates, 
  getTemplatesByCategory, 
  getPopularTemplates,
  categoryLabels,
  type AutomationTemplate 
} from "@/data/automationTemplates";
import { useAutomations } from "@/hooks/useAutomations";
import { toast } from "sonner";

interface AutomationTemplateGalleryProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const categoryIcons: Record<string, React.ReactNode> = {
  sales: <ShoppingCart className="h-4 w-4" />,
  purchasing: <Package className="h-4 w-4" />,
  crm: <Users className="h-4 w-4" />,
  inventory: <Boxes className="h-4 w-4" />,
  accounting: <Calculator className="h-4 w-4" />,
  hr: <Users className="h-4 w-4" />,
};

export function AutomationTemplateGallery({
  open,
  onOpenChange,
}: AutomationTemplateGalleryProps) {
  const { createAutomation } = useAutomations();
  const [selectedTemplate, setSelectedTemplate] = useState<AutomationTemplate | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [createdTemplates, setCreatedTemplates] = useState<Set<string>>(new Set());

  const popularTemplates = getPopularTemplates();
  const categories = ["sales", "crm", "inventory", "purchasing", "accounting"];

  const handleUseTemplate = async (template: AutomationTemplate) => {
    setIsCreating(true);
    try {
      await createAutomation({
        name: template.name,
        description: template.description,
        target_model: template.targetModel,
        trigger_type: template.triggerType as any,
        trigger_conditions: template.triggerConditions ? [template.triggerConditions] as any : null,
        filter_domain: [],
        watched_fields: null,
        schedule_type: null,
        schedule_config: null,
        next_run_at: null,
        last_run_at: null,
        run_as_user_id: null,
        max_retries: 3,
        retry_delay_seconds: 60,
        business_id: null,
        is_active: false,
      });

      setCreatedTemplates(prev => new Set([...prev, template.id]));
      toast.success(`Automation "${template.name}" created! Review and enable it in your automations list.`);
    } catch (error) {
      console.error("Failed to create automation:", error);
      toast.error("Failed to create automation");
    } finally {
      setIsCreating(false);
    }
  };

  const TemplateCard = ({ template }: { template: AutomationTemplate }) => {
    const Icon = template.icon;
    const isCreated = createdTemplates.has(template.id);

    return (
      <Card 
        className={`cursor-pointer transition-all hover:border-primary/50 ${
          selectedTemplate?.id === template.id ? "border-primary ring-1 ring-primary" : ""
        }`}
        onClick={() => setSelectedTemplate(template)}
      >
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-2">
              <div className="p-2 rounded-lg bg-primary/10">
                <Icon className="h-4 w-4 text-primary" />
              </div>
              <div>
                <CardTitle className="text-sm font-medium">{template.name}</CardTitle>
                <Badge variant="secondary" className="text-xs mt-1">
                  {categoryLabels[template.category]}
                </Badge>
              </div>
            </div>
            {template.isPopular && (
              <Badge variant="default" className="bg-amber-100 text-amber-800 text-xs">
                <TrendingUp className="h-3 w-3 mr-1" />
                Popular
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <CardDescription className="text-xs line-clamp-2">
            {template.description}
          </CardDescription>
          <div className="mt-3 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {template.steps.length} step{template.steps.length !== 1 ? "s" : ""}
            </span>
            {isCreated ? (
              <Badge variant="outline" className="text-green-600">
                <Check className="h-3 w-3 mr-1" />
                Added
              </Badge>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="text-xs h-7"
                onClick={(e) => {
                  e.stopPropagation();
                  handleUseTemplate(template);
                }}
                disabled={isCreating}
              >
                {isCreating ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  "Use Template"
                )}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[800px] max-h-[85vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Automation Templates
          </DialogTitle>
          <DialogDescription>
            Pre-built automation workflows to help you automate common business processes
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="popular" className="flex-1">
          <TabsList className="grid w-full grid-cols-6">
            <TabsTrigger value="popular" className="text-xs">
              <TrendingUp className="h-3 w-3 mr-1" />
              Popular
            </TabsTrigger>
            {categories.map((cat) => (
              <TabsTrigger key={cat} value={cat} className="text-xs">
                {categoryIcons[cat]}
                <span className="ml-1 hidden sm:inline">{categoryLabels[cat]}</span>
              </TabsTrigger>
            ))}
          </TabsList>

          <ScrollArea className="h-[400px] mt-4">
            <TabsContent value="popular" className="mt-0">
              <div className="grid gap-3 sm:grid-cols-2">
                {popularTemplates.map((template) => (
                  <TemplateCard key={template.id} template={template} />
                ))}
              </div>
            </TabsContent>

            {categories.map((cat) => (
              <TabsContent key={cat} value={cat} className="mt-0">
                <div className="grid gap-3 sm:grid-cols-2">
                  {getTemplatesByCategory(cat).map((template) => (
                    <TemplateCard key={template.id} template={template} />
                  ))}
                </div>
                {getTemplatesByCategory(cat).length === 0 && (
                  <div className="text-center py-8 text-muted-foreground">
                    No templates available for this category yet
                  </div>
                )}
              </TabsContent>
            ))}
          </ScrollArea>
        </Tabs>

        {/* Selected Template Details */}
        {selectedTemplate && (
          <div className="border rounded-lg p-4 bg-muted/30">
            <div className="flex items-start justify-between mb-3">
              <div>
                <h4 className="font-medium">{selectedTemplate.name}</h4>
                <p className="text-sm text-muted-foreground">{selectedTemplate.description}</p>
              </div>
              <Button
                size="sm"
                onClick={() => handleUseTemplate(selectedTemplate)}
                disabled={isCreating || createdTemplates.has(selectedTemplate.id)}
              >
                {isCreating ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : createdTemplates.has(selectedTemplate.id) ? (
                  <Check className="h-4 w-4 mr-2" />
                ) : null}
                {createdTemplates.has(selectedTemplate.id) ? "Added" : "Use Template"}
              </Button>
            </div>
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">Workflow Steps:</div>
              <div className="flex flex-wrap gap-2">
                {selectedTemplate.steps.map((step, index) => (
                  <Badge key={index} variant="outline" className="text-xs">
                    {index + 1}. {step.stepName}
                  </Badge>
                ))}
              </div>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
