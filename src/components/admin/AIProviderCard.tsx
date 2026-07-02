import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AIProvider, AIApiKey } from "@/hooks/useAIProviders";
import { ChevronDown, ChevronUp, Plus, Trash2, Key, RefreshCw, AlertTriangle, CheckCircle, Eye, EyeOff, GripVertical } from "lucide-react";
import { cn } from "@/lib/utils";
import { format, formatDistanceToNow } from "date-fns";

interface AIProviderCardProps {
  provider: AIProvider;
  apiKeys: AIApiKey[];
  onUpdateProvider: (id: string, updates: Partial<AIProvider>) => Promise<void>;
  onAddApiKey: (providerId: string, keyName: string, apiKey: string) => Promise<any>;
  onUpdateApiKey: (id: string, updates: Partial<AIApiKey>) => Promise<void>;
  onDeleteApiKey: (id: string) => Promise<void>;
  onTestApiKey: (providerId: string, apiKey: string) => Promise<boolean>;
  isSaving: boolean;
}

export function AIProviderCard({
  provider,
  apiKeys,
  onUpdateProvider,
  onAddApiKey,
  onUpdateApiKey,
  onDeleteApiKey,
  onTestApiKey,
  isSaving,
}: AIProviderCardProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [isAddKeyOpen, setIsAddKeyOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newApiKey, setNewApiKey] = useState("");
  const [showNewKey, setShowNewKey] = useState(false);
  const [testingKey, setTestingKey] = useState<string | null>(null);
  const [keyVisibility, setKeyVisibility] = useState<Record<string, boolean>>({});

  const handleAddKey = async () => {
    if (!newKeyName.trim() || !newApiKey.trim()) return;
    
    const result = await onAddApiKey(provider.id, newKeyName.trim(), newApiKey.trim());
    if (result) {
      setNewKeyName("");
      setNewApiKey("");
      setIsAddKeyOpen(false);
    }
  };

  const handleTestKey = async (key: AIApiKey) => {
    setTestingKey(key.id);
    // Plaintext keys are no longer exposed to the client — they live in Supabase Vault.
    // Pass the row id so the server-side test endpoint can resolve the secret.
    await onTestApiKey(provider.id, key.id);
    setTestingKey(null);
  };

  const maskApiKey = (_key: string | null) => {
    return "••••  stored in Vault  ••••";
  };

  const getProviderIcon = (code: string) => {
    switch (code) {
      case "openai":
        return "🤖";
      case "groq":
        return "⚡";
      case "gemini":
        return "💎";
      case "openrouter":
        return "🌐";
      case "lovable":
        return "🤖";
      default:
        return "🔧";
    }
  };

  return (
    <Card className={cn(!provider.is_enabled && "opacity-60")}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-2xl">{getProviderIcon(provider.provider_code)}</span>
            <div>
              <CardTitle className="text-lg flex items-center gap-2">
                {provider.display_name}
                {provider.provider_code === "lovable" && (
                  <Badge variant="secondary" className="text-xs">Built-in</Badge>
                )}
              </CardTitle>
              <CardDescription className="text-xs">
                Priority: {provider.priority} • {apiKeys.length} API key{apiKeys.length !== 1 ? "s" : ""}
              </CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center space-x-2">
              <Switch
                id={`enable-${provider.id}`}
                checked={provider.is_enabled}
                onCheckedChange={(checked) => onUpdateProvider(provider.id, { is_enabled: checked })}
                disabled={isSaving}
              />
              <Label htmlFor={`enable-${provider.id}`} className="text-sm">
                {provider.is_enabled ? "Enabled" : "Disabled"}
              </Label>
            </div>
          </div>
        </div>
      </CardHeader>

      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" className="w-full justify-between px-6 py-2 h-auto">
            <span className="text-sm text-muted-foreground">
              {isOpen ? "Hide configuration" : "Show configuration"}
            </span>
            {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </Button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <CardContent className="pt-4 space-y-6">
            {/* Provider Settings */}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Default Model</Label>
                <Select
                  value={provider.default_model || ""}
                  onValueChange={(value) => onUpdateProvider(provider.id, { default_model: value })}
                  disabled={isSaving}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select model" />
                  </SelectTrigger>
                  <SelectContent>
                    {provider.available_models.map((model) => (
                      <SelectItem key={model} value={model}>
                        {model}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Priority (lower = higher priority)</Label>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={provider.priority}
                  onChange={(e) => onUpdateProvider(provider.id, { priority: parseInt(e.target.value) || 1 })}
                  disabled={isSaving}
                />
              </div>
            </div>

            {/* API Keys Section */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="text-base font-medium">API Keys</Label>
                {provider.provider_code !== "lovable" && (
                  <Dialog open={isAddKeyOpen} onOpenChange={setIsAddKeyOpen}>
                    <DialogTrigger asChild>
                      <Button variant="outline" size="sm">
                        <Plus className="h-4 w-4 mr-1" />
                        Add Key
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Add API Key for {provider.display_name}</DialogTitle>
                        <DialogDescription>
                          Enter a name and your API key. The key will be encrypted and stored securely.
                        </DialogDescription>
                      </DialogHeader>
                      <div className="space-y-4 py-4">
                        <div className="space-y-2">
                          <Label>Key Name</Label>
                          <Input
                            placeholder="e.g., Production Key 1"
                            value={newKeyName}
                            onChange={(e) => setNewKeyName(e.target.value)}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>API Key</Label>
                          <div className="relative">
                            <Input
                              type={showNewKey ? "text" : "password"}
                              placeholder="sk-..."
                              value={newApiKey}
                              onChange={(e) => setNewApiKey(e.target.value)}
                            />
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="absolute right-0 top-0 h-full"
                              onClick={() => setShowNewKey(!showNewKey)}
                            >
                              {showNewKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                            </Button>
                          </div>
                        </div>
                      </div>
                      <DialogFooter>
                        <Button variant="outline" onClick={() => setIsAddKeyOpen(false)}>
                          Cancel
                        </Button>
                        <Button onClick={handleAddKey} disabled={!newKeyName.trim() || !newApiKey.trim() || isSaving}>
                          Add Key
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                )}
              </div>

              {provider.provider_code === "lovable" ? (
                <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                  <Key className="h-8 w-8 mx-auto mb-2 text-primary" />
                  <p>This AI provider uses a built-in API key that is automatically configured.</p>
                  <p className="text-xs mt-1">No additional configuration needed.</p>
                </div>
              ) : apiKeys.length === 0 ? (
                <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                  <Key className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p>No API keys configured</p>
                  <p className="text-xs mt-1">Add an API key to enable this provider</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {apiKeys.map((key) => (
                    <div
                      key={key.id}
                      className={cn(
                        "flex items-center gap-3 p-3 rounded-lg border bg-card",
                        !key.is_enabled && "opacity-60"
                      )}
                    >
                      <GripVertical className="h-4 w-4 text-muted-foreground cursor-move" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">{key.key_name}</span>
                          <Badge variant="outline" className="text-xs">
                            #{key.priority}
                          </Badge>
                          {key.last_rate_limited_at && (
                            <Badge variant="destructive" className="text-xs">
                              <AlertTriangle className="h-3 w-3 mr-1" />
                              Rate limited
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <code className="text-xs text-muted-foreground font-mono">
                            {maskApiKey(key.api_key_encrypted)}
                          </code>
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                          <span>{key.total_requests} requests</span>
                          {key.last_used_at && (
                            <span>Last used {formatDistanceToNow(new Date(key.last_used_at))} ago</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch
                          checked={key.is_enabled}
                          onCheckedChange={(checked) => onUpdateApiKey(key.id, { is_enabled: checked })}
                          disabled={isSaving}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleTestKey(key)}
                          disabled={testingKey === key.id}
                        >
                          {testingKey === key.id ? (
                            <RefreshCw className="h-4 w-4 animate-spin" />
                          ) : (
                            <CheckCircle className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => onDeleteApiKey(key.id)}
                          disabled={isSaving}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
