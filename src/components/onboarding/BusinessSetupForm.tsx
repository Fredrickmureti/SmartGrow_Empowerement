import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Building2, Globe, Briefcase, ArrowRight } from "lucide-react";
import { businessTypes, industryTypes } from "@/lib/countryCurrency";
import { useCountries, getCurrencyByCountryCode } from "@/hooks/useCountries";

interface BusinessSetupFormProps {
  onSubmit: (data: {
    businessName: string;
    country: string;
    currency: string;
    businessType?: string;
    industry?: string;
  }) => Promise<void>;
  isLoading?: boolean;
}

export function BusinessSetupForm({ onSubmit, isLoading }: BusinessSetupFormProps) {
  const [businessName, setBusinessName] = useState("");
  const [country, setCountry] = useState("");
  const [businessType, setBusinessType] = useState("");
  const [industry, setIndustry] = useState("");
  const [countrySearch, setCountrySearch] = useState("");

  const { countries } = useCountries();
  const filteredCountries = countrySearch
    ? countries.filter(c => 
        c.name.toLowerCase().includes(countrySearch.toLowerCase()) ||
        c.code.toLowerCase().includes(countrySearch.toLowerCase())
      )
    : countries;

  const selectedCountryData = countries.find(c => c.code === country);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!businessName.trim() || !country) return;

    await onSubmit({
      businessName: businessName.trim(),
      country,
      currency: getCurrencyByCountryCode(countries, country),
      businessType: businessType || undefined,
      industry: industry || undefined,
    });
  };

  return (
    <Card className="w-full max-w-lg mx-auto">
      <CardHeader className="text-center pb-2">
        <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
          <Building2 className="w-8 h-8 text-primary" />
        </div>
        <CardTitle className="text-2xl">Set up your business</CardTitle>
        <CardDescription className="text-base">
          Tell us a bit about your business to personalize your experience
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Business Name */}
          <div className="space-y-2">
            <Label htmlFor="businessName" className="flex items-center gap-2">
              <Briefcase className="h-4 w-4" />
              Business Name *
            </Label>
            <Input
              id="businessName"
              type="text"
              placeholder="Acme Corporation"
              value={businessName}
              onChange={(e) => setBusinessName(e.target.value)}
              required
              className="h-11"
            />
            <p className="text-xs text-muted-foreground">
              This will be your organization name in AccrualFlow
            </p>
          </div>

          {/* Country */}
          <div className="space-y-2">
            <Label htmlFor="country" className="flex items-center gap-2">
              <Globe className="h-4 w-4" />
              Country *
            </Label>
            <Select value={country} onValueChange={setCountry} required>
              <SelectTrigger className="h-11">
                <SelectValue placeholder="Select your country" />
              </SelectTrigger>
              <SelectContent>
                <div className="px-2 pb-2">
                  <Input
                    placeholder="Search countries..."
                    value={countrySearch}
                    onChange={(e) => setCountrySearch(e.target.value)}
                    className="h-9"
                  />
                </div>
                <div className="max-h-[200px] overflow-y-auto">
                  {filteredCountries.map((c) => (
                    <SelectItem key={c.code} value={c.code}>
                      <span className="flex items-center gap-2">
                        {c.name}
                        <span className="text-muted-foreground text-xs">({c.currency})</span>
                      </span>
                    </SelectItem>
                  ))}
                </div>
              </SelectContent>
            </Select>
            {selectedCountryData && (
              <p className="text-xs text-muted-foreground">
                Base currency will be set to <strong>{selectedCountryData.currency}</strong>
              </p>
            )}
          </div>

          {/* Business Type (Optional) */}
          <div className="space-y-2">
            <Label htmlFor="businessType">Business Type (optional)</Label>
            <Select value={businessType} onValueChange={setBusinessType}>
              <SelectTrigger className="h-11">
                <SelectValue placeholder="Select business type" />
              </SelectTrigger>
              <SelectContent>
                {businessTypes.map((type) => (
                  <SelectItem key={type.value} value={type.value}>
                    {type.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Industry (Optional) */}
          <div className="space-y-2">
            <Label htmlFor="industry">Industry (optional)</Label>
            <Select value={industry} onValueChange={setIndustry}>
              <SelectTrigger className="h-11">
                <SelectValue placeholder="Select industry" />
              </SelectTrigger>
              <SelectContent>
                {industryTypes.map((type) => (
                  <SelectItem key={type.value} value={type.value}>
                    {type.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Button
            type="submit"
            className="w-full h-11"
            disabled={isLoading || !businessName.trim() || !country}
          >
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Setting up...
              </>
            ) : (
              <>
                Continue to Dashboard
                <ArrowRight className="ml-2 h-4 w-4" />
              </>
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
