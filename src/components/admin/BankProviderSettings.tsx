// @ts-nocheck - Admin tables not in auto-generated types
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { useBankProviders, BankProvider, BankProviderUpdateData } from "@/hooks/useBankProviders";
import {
  Building2,
  Loader2,
  Settings2,
  TestTube2,
  Shield,
  ExternalLink,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ImageIcon,
} from "lucide-react";

export function BankProviderSettings() {
  const { providers, isLoading, isSaving, updateProvider, toggleProvider, testConnection } = useBankProviders();
  const [configDialogOpen, setConfigDialogOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<BankProvider | null>(null);
  const [testingConnection, setTestingConnection] = useState<string | null>(null);
  
  // Form state
  const [formData, setFormData] = useState<BankProviderUpdateData>({});

  const openConfigDialog = (provider: BankProvider) => {
    setSelectedProvider(provider);
    setFormData({
      api_key_encrypted: provider.api_key_encrypted || "",
      api_secret_encrypted: provider.api_secret_encrypted || "",
      merchant_code: provider.merchant_code || "",
      public_key: provider.public_key || "",
      private_key_encrypted: provider.private_key_encrypted || "",
      is_sandbox: provider.is_sandbox,
      logo_url: provider.logo_url || "",
    });
    setConfigDialogOpen(true);
  };

  const handleSaveConfig = async () => {
    if (!selectedProvider) return;
    
    try {
      await updateProvider(selectedProvider.id, formData);
      setConfigDialogOpen(false);
    } catch {
      // Error handled in hook
    }
  };

  const handleTestConnection = async (providerId: string) => {
    setTestingConnection(providerId);
    await testConnection(providerId);
    setTestingConnection(null);
  };

  const getProviderStatus = (provider: BankProvider) => {
    if (!provider.is_enabled) {
      return { status: "disabled", color: "secondary", icon: XCircle };
    }
    if (!provider.api_key_encrypted) {
      return { status: "not configured", color: "outline", icon: AlertTriangle };
    }
    return { status: provider.is_sandbox ? "sandbox" : "live", color: provider.is_sandbox ? "outline" : "default", icon: CheckCircle2 };
  };

  const getProviderDocs = (providerCode: string) => {
    const docs: Record<string, string> = {
      jenga: "https://developer.jengaapi.io/docs",
      kcb_buni: "https://developer.kcbbankgroup.com/",
      coop_connect: "https://developer.co-opbank.co.ke/docs",
      ncba: "http://developers.cbagroup.com:4040/home",
      absa: "https://developer.absa.africa/",
      stanchart: "https://openbanking.sc.com/",
      im_bank: "https://www.imbankgroup.com/ke/business-solutions/paymentapigateway/",
      stanbic: "https://sandbox.stanbicbank.co.ke/",
      dtb_astra: "https://www.astraafrica.co/developers/",
      manual: "#",
    };
    return docs[providerCode] || "#";
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5" />
              Bank Provider Integrations
            </CardTitle>
            <CardDescription>
              Configure API credentials for bank integrations. Organizations will be able to connect their bank accounts using enabled providers.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Accordion type="single" collapsible className="w-full">
              {providers.map((provider) => {
                const status = getProviderStatus(provider);
                const StatusIcon = status.icon;
                
                return (
                  <AccordionItem key={provider.id} value={provider.id}>
                    <AccordionTrigger className="hover:no-underline">
                      <div className="flex items-center gap-4 w-full pr-4">
                        <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center overflow-hidden">
                          {provider.logo_url ? (
                            <img 
                              src={provider.logo_url} 
                              alt={provider.provider_name}
                              className="h-full w-full object-contain"
                              onError={(e) => {
                                e.currentTarget.style.display = 'none';
                                e.currentTarget.nextElementSibling?.classList.remove('hidden');
                              }}
                            />
                          ) : null}
                          <Building2 className={`h-5 w-5 ${provider.logo_url ? 'hidden' : ''}`} />
                        </div>
                        <div className="flex-1 text-left">
                          <div className="font-medium">{provider.provider_name}</div>
                          <div className="text-sm text-muted-foreground">
                            {provider.description}
                          </div>
                        </div>
                        <Badge variant={status.color as "default" | "secondary" | "outline"}>
                          <StatusIcon className="h-3 w-3 mr-1" />
                          {status.status}
                        </Badge>
                      </div>
                    </AccordionTrigger>
                    <AccordionContent className="pt-4">
                      <div className="space-y-4 pl-14">
                        <div className="flex items-center justify-between">
                          <div className="space-y-0.5">
                            <Label>Enable Provider</Label>
                            <p className="text-sm text-muted-foreground">
                              Allow organizations to connect using this provider
                            </p>
                          </div>
                          <Switch
                            checked={provider.is_enabled}
                            onCheckedChange={(checked) => toggleProvider(provider.id, checked)}
                            disabled={isSaving || provider.provider_code === "manual"}
                          />
                        </div>
                        
                        <Separator />
                        
                        <div className="grid gap-4 sm:grid-cols-2">
                          <div className="p-4 rounded-lg bg-muted/50">
                            <p className="text-sm text-muted-foreground">API Base URL</p>
                            <p className="font-medium text-sm truncate">
                              {provider.api_base_url || "N/A"}
                            </p>
                          </div>
                          <div className="p-4 rounded-lg bg-muted/50">
                            <p className="text-sm text-muted-foreground">Supported Countries</p>
                            <div className="flex gap-1 mt-1">
                              {provider.supported_countries.map((country) => (
                                <Badge key={country} variant="secondary" className="text-xs">
                                  {country}
                                </Badge>
                              ))}
                            </div>
                          </div>
                        </div>
                        
                        <div className="flex items-center gap-2">
                          {provider.provider_code !== "manual" && (
                            <>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => openConfigDialog(provider)}
                              >
                                <Settings2 className="h-4 w-4 mr-2" />
                                Configure Credentials
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleTestConnection(provider.id)}
                                disabled={!provider.api_key_encrypted || testingConnection === provider.id}
                              >
                                {testingConnection === provider.id ? (
                                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                ) : (
                                  <TestTube2 className="h-4 w-4 mr-2" />
                                )}
                                Test Connection
                              </Button>
                            </>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            asChild
                          >
                            <a
                              href={getProviderDocs(provider.provider_code)}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              <ExternalLink className="h-4 w-4 mr-2" />
                              Documentation
                            </a>
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

        {/* Security Note */}
        <Card className="border-amber-500/50 bg-amber-500/5">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2 text-amber-700 dark:text-amber-400">
              <Shield className="h-5 w-5" />
              Security Notice
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              All API credentials are encrypted before storage. Bank API calls are processed through secure edge functions
              and credentials are never exposed to the frontend. Ensure you use sandbox/test credentials during development.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Configuration Dialog */}
      <Dialog open={configDialogOpen} onOpenChange={setConfigDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Configure {selectedProvider?.provider_name}</DialogTitle>
            <DialogDescription>
              Enter the API credentials for this bank provider. All credentials are encrypted before storage.
            </DialogDescription>
          </DialogHeader>

          {selectedProvider && (
            <div className="space-y-6 py-4">
              {/* Bank Logo Configuration */}
              <div className="space-y-3">
                <Label className="flex items-center gap-2">
                  <ImageIcon className="h-4 w-4" />
                  Bank Logo
                </Label>
                <div className="flex items-center gap-4">
                  <div className="h-16 w-16 rounded-lg border bg-muted flex items-center justify-center overflow-hidden">
                    {formData.logo_url ? (
                      <img 
                        src={formData.logo_url as string} 
                        alt="Bank logo preview"
                        className="h-full w-full object-contain"
                        onError={(e) => {
                          e.currentTarget.style.display = 'none';
                        }}
                      />
                    ) : (
                      <Building2 className="h-8 w-8 text-muted-foreground" />
                    )}
                  </div>
                  <div className="flex-1 space-y-2">
                    <Input
                      placeholder="https://example.com/bank-logo.png"
                      value={(formData.logo_url as string) || ""}
                      onChange={(e) => setFormData({ ...formData, logo_url: e.target.value })}
                    />
                    <p className="text-xs text-muted-foreground">
                      Enter a URL to the bank's logo. Recommended size: 200x200px, PNG or SVG format.
                    </p>
                  </div>
                </div>
              </div>

              <Separator />

              {/* Environment Toggle */}
              <div className="flex items-center justify-between p-4 rounded-lg bg-muted/50">
                <div className="space-y-0.5">
                  <Label>Environment</Label>
                  <p className="text-sm text-muted-foreground">
                    {formData.is_sandbox 
                      ? "Using sandbox/test credentials" 
                      : "Using production credentials"
                    }
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-sm">Sandbox</span>
                  <Switch
                    checked={!formData.is_sandbox}
                    onCheckedChange={(checked) => setFormData({ ...formData, is_sandbox: !checked })}
                  />
                  <span className="text-sm">Production</span>
                </div>
              </div>

              <Separator />

              {/* Jenga API specific fields */}
              {selectedProvider.provider_code === "jenga" && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="merchant-code">Merchant Code</Label>
                    <Input
                      id="merchant-code"
                      value={formData.merchant_code || ""}
                      onChange={(e) => setFormData({ ...formData, merchant_code: e.target.value })}
                      placeholder="Enter your Jenga merchant code"
                    />
                    <p className="text-xs text-muted-foreground">
                      Your unique merchant identifier from Jenga API
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="api-key">API Key</Label>
                    <Input
                      id="api-key"
                      type="password"
                      value={formData.api_key_encrypted || ""}
                      onChange={(e) => setFormData({ ...formData, api_key_encrypted: e.target.value })}
                      placeholder="Enter your API key"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="api-secret">API Secret</Label>
                    <Input
                      id="api-secret"
                      type="password"
                      value={formData.api_secret_encrypted || ""}
                      onChange={(e) => setFormData({ ...formData, api_secret_encrypted: e.target.value })}
                      placeholder="Enter your API secret"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="public-key">Public Key (for signature verification)</Label>
                    <Textarea
                      id="public-key"
                      value={formData.public_key || ""}
                      onChange={(e) => setFormData({ ...formData, public_key: e.target.value })}
                      placeholder="-----BEGIN PUBLIC KEY-----&#10;...&#10;-----END PUBLIC KEY-----"
                      rows={4}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="private-key">Private Key (for request signing)</Label>
                    <Textarea
                      id="private-key"
                      value={formData.private_key_encrypted || ""}
                      onChange={(e) => setFormData({ ...formData, private_key_encrypted: e.target.value })}
                      placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
                      rows={4}
                    />
                    <p className="text-xs text-muted-foreground">
                      Your private key for signing API requests. Keep this secure.
                    </p>
                  </div>
                </>
              )}

              {/* KCB BUNI specific fields */}
              {selectedProvider.provider_code === "kcb_buni" && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="api-key">Consumer Key</Label>
                    <Input
                      id="api-key"
                      type="password"
                      value={formData.api_key_encrypted || ""}
                      onChange={(e) => setFormData({ ...formData, api_key_encrypted: e.target.value })}
                      placeholder="Enter your consumer key"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="api-secret">Consumer Secret</Label>
                    <Input
                      id="api-secret"
                      type="password"
                      value={formData.api_secret_encrypted || ""}
                      onChange={(e) => setFormData({ ...formData, api_secret_encrypted: e.target.value })}
                      placeholder="Enter your consumer secret"
                    />
                  </div>
                </>
              )}

              {/* Co-op Connect specific fields */}
              {selectedProvider.provider_code === "coop_connect" && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="api-key">Client ID</Label>
                    <Input
                      id="api-key"
                      type="password"
                      value={formData.api_key_encrypted || ""}
                      onChange={(e) => setFormData({ ...formData, api_key_encrypted: e.target.value })}
                      placeholder="Enter your client ID"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="api-secret">Client Secret</Label>
                    <Input
                      id="api-secret"
                      type="password"
                      value={formData.api_secret_encrypted || ""}
                      onChange={(e) => setFormData({ ...formData, api_secret_encrypted: e.target.value })}
                      placeholder="Enter your client secret"
                    />
                  </div>
                </>
              )}

              {/* NCBA Bank specific fields */}
              {selectedProvider.provider_code === "ncba" && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="api-user">API User</Label>
                    <Input
                      id="api-user"
                      value={formData.merchant_code || ""}
                      onChange={(e) => setFormData({ ...formData, merchant_code: e.target.value })}
                      placeholder="Enter your API username"
                    />
                    <p className="text-xs text-muted-foreground">
                      Your NCBA Open Banking API username
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="api-key">API Key</Label>
                    <Input
                      id="api-key"
                      type="password"
                      value={formData.api_key_encrypted || ""}
                      onChange={(e) => setFormData({ ...formData, api_key_encrypted: e.target.value })}
                      placeholder="Enter your API key"
                    />
                  </div>
                </>
              )}

              {/* Absa Bank specific fields */}
              {selectedProvider.provider_code === "absa" && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="client-id">Client ID</Label>
                    <Input
                      id="client-id"
                      value={formData.api_key_encrypted || ""}
                      onChange={(e) => setFormData({ ...formData, api_key_encrypted: e.target.value })}
                      placeholder="Enter your OAuth Client ID"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="client-secret">Client Secret</Label>
                    <Input
                      id="client-secret"
                      type="password"
                      value={formData.api_secret_encrypted || ""}
                      onChange={(e) => setFormData({ ...formData, api_secret_encrypted: e.target.value })}
                      placeholder="Enter your OAuth Client Secret"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="certificate">mTLS Certificate (PEM)</Label>
                    <Textarea
                      id="certificate"
                      value={formData.private_key_encrypted || ""}
                      onChange={(e) => setFormData({ ...formData, private_key_encrypted: e.target.value })}
                      placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"
                      rows={4}
                    />
                    <p className="text-xs text-muted-foreground">
                      Required for production environment mTLS authentication
                    </p>
                  </div>
                </>
              )}

              {/* Standard Chartered specific fields */}
              {selectedProvider.provider_code === "stanchart" && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="api-key">API Key</Label>
                    <Input
                      id="api-key"
                      type="password"
                      value={formData.api_key_encrypted || ""}
                      onChange={(e) => setFormData({ ...formData, api_key_encrypted: e.target.value })}
                      placeholder="Enter your API key"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="api-secret">API Secret</Label>
                    <Input
                      id="api-secret"
                      type="password"
                      value={formData.api_secret_encrypted || ""}
                      onChange={(e) => setFormData({ ...formData, api_secret_encrypted: e.target.value })}
                      placeholder="Enter your API secret"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="jwt-key">JWT Signing Key</Label>
                    <Textarea
                      id="jwt-key"
                      value={formData.private_key_encrypted || ""}
                      onChange={(e) => setFormData({ ...formData, private_key_encrypted: e.target.value })}
                      placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"
                      rows={4}
                    />
                    <p className="text-xs text-muted-foreground">
                      Private key for JWT token signing
                    </p>
                  </div>
                </>
              )}

              {/* I&M Bank specific fields */}
              {selectedProvider.provider_code === "im_bank" && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="username">Username</Label>
                    <Input
                      id="username"
                      value={formData.merchant_code || ""}
                      onChange={(e) => setFormData({ ...formData, merchant_code: e.target.value })}
                      placeholder="Enter your API username"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="password">Password / API Key</Label>
                    <Input
                      id="password"
                      type="password"
                      value={formData.api_key_encrypted || ""}
                      onChange={(e) => setFormData({ ...formData, api_key_encrypted: e.target.value })}
                      placeholder="Enter your password or API key"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="security-token">Security Token</Label>
                    <Input
                      id="security-token"
                      type="password"
                      value={formData.api_secret_encrypted || ""}
                      onChange={(e) => setFormData({ ...formData, api_secret_encrypted: e.target.value })}
                      placeholder="Enter your 2FA security token"
                    />
                    <p className="text-xs text-muted-foreground">
                      Two-factor authentication token for host-to-host integration
                    </p>
                  </div>
                </>
              )}

              {/* Stanbic Bank specific fields */}
              {selectedProvider.provider_code === "stanbic" && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="consumer-key">Consumer Key</Label>
                    <Input
                      id="consumer-key"
                      type="password"
                      value={formData.api_key_encrypted || ""}
                      onChange={(e) => setFormData({ ...formData, api_key_encrypted: e.target.value })}
                      placeholder="Enter your consumer key"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="consumer-secret">Consumer Secret</Label>
                    <Input
                      id="consumer-secret"
                      type="password"
                      value={formData.api_secret_encrypted || ""}
                      onChange={(e) => setFormData({ ...formData, api_secret_encrypted: e.target.value })}
                      placeholder="Enter your consumer secret"
                    />
                  </div>
                </>
              )}

              {/* DTB Astra specific fields */}
              {selectedProvider.provider_code === "dtb_astra" && (
                <>
                  <div className="space-y-2">
                    <Label htmlFor="merchant-id">Merchant ID</Label>
                    <Input
                      id="merchant-id"
                      value={formData.merchant_code || ""}
                      onChange={(e) => setFormData({ ...formData, merchant_code: e.target.value })}
                      placeholder="Enter your Astra merchant ID"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="api-key">API Key</Label>
                    <Input
                      id="api-key"
                      type="password"
                      value={formData.api_key_encrypted || ""}
                      onChange={(e) => setFormData({ ...formData, api_key_encrypted: e.target.value })}
                      placeholder="Enter your API key"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="api-secret">API Secret</Label>
                    <Input
                      id="api-secret"
                      type="password"
                      value={formData.api_secret_encrypted || ""}
                      onChange={(e) => setFormData({ ...formData, api_secret_encrypted: e.target.value })}
                      placeholder="Enter your API secret"
                    />
                  </div>
                </>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setConfigDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveConfig} disabled={isSaving}>
              {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save Configuration
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
