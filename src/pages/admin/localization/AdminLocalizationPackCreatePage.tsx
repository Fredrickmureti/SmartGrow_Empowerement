/**
 * AdminLocalizationPackCreatePage — workspace at
 * `/admin-management/localization-packs/new`. Replaces the legacy
 * `CreatePackDialog` from `src/pages/admin/AdminLocalizationPacks.tsx`.
 */
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Section } from "@/design-system";
import { AdminRecordForm, AdminFieldGrid, AdminFieldCell } from "@/apps/platform-admin";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { adminFrom } from "@/lib/adminClient";
import { useCountries } from "@/hooks/useCountries";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

const LIST_PATH = "/admin-management/localization-packs";

export default function AdminLocalizationPackCreatePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { countries } = useCountries();

  const [countryCode, setCountryCode] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!countryCode || !name.trim()) {
      toast.error("Country and pack name are required");
      return;
    }
    setIsSubmitting(true);
    const { error } = await adminFrom("localization_packs").insert({
      country_code: countryCode,
      name: name.trim(),
      description: description || null,
      version,
      is_active: true,
      is_published: false,
    });
    setIsSubmitting(false);
    if (error) {
      toast.error(`Failed: ${normalizeError(error).message}`);
      return;
    }
    toast.success("Localization pack created");
    queryClient.invalidateQueries({ queryKey: ["admin-localization-packs"] });
    navigate(LIST_PATH);
  };

  return (
    <AdminRecordForm
      mode="create"
      entityLabel="Localization pack"
      meta="Create a new country-specific fiscal &amp; payroll configuration pack. You can edit its rules, templates, and versions after creation."
      cancelHref={LIST_PATH}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      submitLabel="Create pack"
    >
      <Section title="Identity" description="How this pack is described in the admin console.">
        <AdminFieldGrid columns={2}>
          <div className="space-y-2">
            <Label>Country *</Label>
            <Select
              value={countryCode}
              onValueChange={(v) => {
                setCountryCode(v);
                const c = countries.find((x) => x.code === v);
                if (c && !name) setName(`${c.name} Fiscal Localization`);
              }}
            >
              <SelectTrigger><SelectValue placeholder="Select country" /></SelectTrigger>
              <SelectContent>
                {countries.map((c) => (
                  <SelectItem key={c.code} value={c.code}>
                    {c.name} ({c.currency})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="pack-version">Initial version</Label>
            <Input id="pack-version" value={version} onChange={(e) => setVersion(e.target.value)} />
          </div>
          <AdminFieldCell span={2}>
            <div className="space-y-2">
              <Label htmlFor="pack-name">Pack name *</Label>
              <Input id="pack-name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
          </AdminFieldCell>
          <AdminFieldCell span={2}>
            <div className="space-y-2">
              <Label htmlFor="pack-desc">Description</Label>
              <Textarea
                id="pack-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
              />
            </div>
          </AdminFieldCell>
        </AdminFieldGrid>
      </Section>
    </AdminRecordForm>
  );
}
