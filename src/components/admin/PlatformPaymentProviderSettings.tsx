// @ts-nocheck - Admin tables not in auto-generated types
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  usePlatformPaymentProviders,
  PlatformPaymentProvider,
  PROVIDER_CREDENTIAL_FIELDS,
} from "@/hooks/usePlatformPaymentProviders";
import {
  CreditCard,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Eye,
  EyeOff,
  RefreshCw,
  Copy,
  ExternalLink,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useToast } from "@/hooks/use-toast";

interface ProviderCredentials {
  [key: string]: string;
}

const PROVIDER_INFO: Record<PlatformPaymentProvider, { icon: string; description: string; docsUrl: string }> = {
  stripe: {
    icon: "💳",
    description: "Accept credit/debit cards globally with Stripe's secure payment processing.",
    docsUrl: "https://stripe.com/docs/keys",
  },
  paypal: {
    icon: "🅿️",
    description: "Enable PayPal payments for customers worldwide.",
    docsUrl: "https://developer.paypal.com/api/rest/",
  },
  pesapal: {
    icon: "🌍",
    description: "Accept payments across Africa via mobile money, cards, and bank transfers.",
    docsUrl: "https://developer.pesapal.com/",
  },
  mpesa: {
    icon: "📱",
    description: "Accept M-Pesa mobile money payments popular in Kenya and East Africa.",
    docsUrl: "https://developer.safaricom.co.ke/",
  },
};

export function PlatformPaymentProviderSettings() {
  const { toast } = useToast();
  const {
    providers,
    isLoading,
    isSaving,
    isTesting,
    hasRequiredCredentials,
    saveCredentials,
    toggleProvider,
    testConnection,
    refreshProviders,
  } = usePlatformPaymentProviders();

  const [editingProvider, setEditingProvider] = useState<PlatformPaymentProvider | null>(null);
  const [credentialInputs, setCredentialInputs] = useState<ProviderCredentials>({});
  const [visibleFields, setVisibleFields] = useState<Set<string>>(new Set());
  const [testMode, setTestMode] = useState<Record<PlatformPaymentProvider, boolean>>({
    stripe: true,
    paypal: true,
    pesapal: true,
    mpesa: true,
  });

  const handleStartEdit = (provider: PlatformPaymentProvider) => {
    const config = providers.find((p) => p.provider === provider);
    if (config) {
      setCredentialInputs(config.credentials);
      setTestMode((prev) => ({ ...prev, [provider]: config.is_test_mode }));
    }
    setEditingProvider(provider);
  };

  const handleSaveCredentials = async (provider: PlatformPaymentProvider) => {
    try {
      await saveCredentials(provider, credentialInputs, testMode[provider]);
      setEditingProvider(null);
      setCredentialInputs({});
    } catch (error) {
      // Error handled in hook
    }
  };

  const handleCancelEdit = () => {
    setEditingProvider(null);
    setCredentialInputs({});
    setVisibleFields(new Set());
  };

  const toggleFieldVisibility = (fieldKey: string) => {
    setVisibleFields((prev) => {
      const next = new Set(prev);
      if (next.has(fieldKey)) {
        next.delete(fieldKey);
      } else {
        next.add(fieldKey);
      }
      return next;
    });
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({
      title: "Copied",
      description: "URL copied to clipboard",
    });
  };

  const getStatusBadge = (provider: ReturnType<typeof providers.find>) => {
    if (!provider) return null;

    if (!hasRequiredCredentials(provider.provider as PlatformPaymentProvider, provider.credentials)) {
      return (
        <Badge variant="outline" className="gap-1">
          <AlertCircle className="h-3 w-3" />
          Not Configured
        </Badge>
      );
    }

    if (provider.test_status === "success") {
      return (
        <Badge variant="outline" className="gap-1 text-green-600 border-green-600">
          <CheckCircle2 className="h-3 w-3" />
          Connected
        </Badge>
      );
    }

    if (provider.test_status === "failed") {
      return (
        <Badge variant="outline" className="gap-1 text-destructive border-destructive">
          <XCircle className="h-3 w-3" />
          Failed
        </Badge>
      );
    }

    return (
      <Badge variant="outline" className="gap-1">
        <AlertCircle className="h-3 w-3" />
        Untested
      </Badge>
    );
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <CreditCard className="h-5 w-5" />
              Payment Providers
            </CardTitle>
            <CardDescription className="mt-1 text-xs sm:text-sm">
              Configure payment gateways for platform subscriptions. Only enabled providers will be available at checkout.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={refreshProviders} className="self-start sm:self-auto">
            <RefreshCw className="h-4 w-4 mr-1.5" />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <Accordion type="multiple" className="w-full">
          {providers.map((provider) => {
            const providerKey = provider.provider as PlatformPaymentProvider;
            const info = PROVIDER_INFO[providerKey];
            const fields = PROVIDER_CREDENTIAL_FIELDS[providerKey];
            const isEditing = editingProvider === providerKey;

            return (
              <AccordionItem key={provider.id} value={provider.provider}>
                <AccordionTrigger className="hover:no-underline py-3 sm:py-4">
                  <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between w-full pr-2 sm:pr-4 gap-2">
                    <div className="flex items-center gap-2 sm:gap-3">
                      <span className="text-xl sm:text-2xl">{info.icon}</span>
                      <div className="text-left">
                        <div className="font-medium text-sm sm:text-base">{provider.display_name}</div>
                        <div className="text-xs sm:text-sm text-muted-foreground line-clamp-1">{info.description}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 sm:gap-3 ml-8 sm:ml-0">
                      {getStatusBadge(provider)}
                      {provider.is_test_mode && (
                        <Badge variant="secondary" className="text-[10px] sm:text-xs">Sandbox</Badge>
                      )}
                      <Switch
                        checked={provider.is_enabled}
                        onCheckedChange={(checked) => toggleProvider(providerKey, checked)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </div>
                  </div>
                </AccordionTrigger>
                <AccordionContent className="pt-3 sm:pt-4">
                  <div className="space-y-4 sm:space-y-6">
                    {/* Environment Selection */}
                    <div className="space-y-2 sm:space-y-3">
                      <Label className="text-sm">Environment</Label>
                      <RadioGroup
                        value={isEditing ? (testMode[providerKey] ? "sandbox" : "production") : (provider.is_test_mode ? "sandbox" : "production")}
                        onValueChange={(value) => {
                          if (isEditing) {
                            setTestMode((prev) => ({ ...prev, [providerKey]: value === "sandbox" }));
                          }
                        }}
                        disabled={!isEditing}
                        className="flex flex-col sm:flex-row gap-3 sm:gap-6"
                      >
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="sandbox" id={`${providerKey}-sandbox`} />
                          <Label htmlFor={`${providerKey}-sandbox`} className="font-normal cursor-pointer text-sm">
                            Sandbox / Test
                          </Label>
                        </div>
                        <div className="flex items-center space-x-2">
                          <RadioGroupItem value="production" id={`${providerKey}-production`} />
                          <Label htmlFor={`${providerKey}-production`} className="font-normal cursor-pointer text-sm">
                            Production / Live
                          </Label>
                        </div>
                      </RadioGroup>
                    </div>

                    <Separator />

                    {/* Credentials */}
                    <div className="space-y-3 sm:space-y-4">
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
                        <Label className="text-sm sm:text-base">API Credentials</Label>
                        <a
                          href={info.docsUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs sm:text-sm text-primary hover:underline flex items-center gap-1"
                        >
                          Documentation
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>

                      {fields.map((field) => {
                        const currentValue = isEditing
                          ? credentialInputs[field.key] || ""
                          : provider.credentials[field.key] || "";
                        const isVisible = visibleFields.has(`${providerKey}-${field.key}`);
                        const isPasswordField = field.type === "password";

                        return (
                          <div key={field.key} className="space-y-2">
                            <Label htmlFor={`${providerKey}-${field.key}`}>
                              {field.label}
                              {field.required && <span className="text-destructive ml-1">*</span>}
                            </Label>
                            <div className="relative">
                              <Input
                                id={`${providerKey}-${field.key}`}
                                type={isPasswordField && !isVisible ? "password" : "text"}
                                placeholder={field.placeholder}
                                value={isEditing ? currentValue : (currentValue ? "••••••••••••" : "")}
                                onChange={(e) =>
                                  setCredentialInputs((prev) => ({
                                    ...prev,
                                    [field.key]: e.target.value,
                                  }))
                                }
                                disabled={!isEditing}
                                className="pr-10"
                              />
                              {isPasswordField && isEditing && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
                                  onClick={() => toggleFieldVisibility(`${providerKey}-${field.key}`)}
                                >
                                  {isVisible ? (
                                    <EyeOff className="h-4 w-4 text-muted-foreground" />
                                  ) : (
                                    <Eye className="h-4 w-4 text-muted-foreground" />
                                  )}
                                </Button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Webhook/Callback URLs */}
                    {(provider.webhook_url || provider.callback_url) && (
                      <>
                        <Separator />
                        <div className="space-y-4">
                          <Label className="text-base">Integration URLs</Label>
                          <p className="text-sm text-muted-foreground">
                            Configure these URLs in your {provider.display_name} dashboard.
                          </p>
                          {provider.webhook_url && (
                            <div className="space-y-2">
                              <Label>Webhook URL</Label>
                              <div className="flex gap-2">
                                <Input value={provider.webhook_url} readOnly className="font-mono text-sm" />
                                <Button
                                  variant="outline"
                                  size="icon"
                                  onClick={() => copyToClipboard(provider.webhook_url!)}
                                >
                                  <Copy className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>
                          )}
                          {provider.callback_url && (
                            <div className="space-y-2">
                              <Label>Callback URL</Label>
                              <div className="flex gap-2">
                                <Input value={provider.callback_url} readOnly className="font-mono text-sm" />
                                <Button
                                  variant="outline"
                                  size="icon"
                                  onClick={() => copyToClipboard(provider.callback_url!)}
                                >
                                  <Copy className="h-4 w-4" />
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                      </>
                    )}

                    {/* Last Tested */}
                    {provider.last_tested_at && (
                      <div className="text-sm text-muted-foreground">
                        Last tested: {formatDistanceToNow(new Date(provider.last_tested_at), { addSuffix: true })}
                        {provider.test_error && (
                          <span className="text-destructive ml-2">- {provider.test_error}</span>
                        )}
                      </div>
                    )}

                    <Separator />

                    {/* Actions */}
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                      <div className="flex flex-wrap gap-2">
                        {!isEditing ? (
                          <Button variant="outline" size="sm" onClick={() => handleStartEdit(providerKey)}>
                            Edit Credentials
                          </Button>
                        ) : (
                          <>
                            <Button
                              size="sm"
                              onClick={() => handleSaveCredentials(providerKey)}
                              disabled={isSaving}
                            >
                              {isSaving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
                              Save
                            </Button>
                            <Button variant="outline" size="sm" onClick={handleCancelEdit}>
                              Cancel
                            </Button>
                          </>
                        )}
                      </div>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => testConnection(providerKey)}
                        disabled={
                          isTesting === providerKey ||
                          !hasRequiredCredentials(providerKey, provider.credentials)
                        }
                      >
                        {isTesting === providerKey ? (
                          <>
                            <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                            Testing...
                          </>
                        ) : (
                          "Test Connection"
                        )}
                      </Button>
                    </div>
                  </div>
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
      </CardContent>
    </Card>
  );
}
