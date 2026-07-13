import { normalizeError } from "@/services/resilience";
/**
 * AdminProfile — platform admin's own profile editor.
 *
 * Writes to public.profiles (the same table tenant users use). The
 * AdminTeam page joins admins → profiles for display, so as soon as the
 * admin sets their full_name here, the "Unknown" disappears across the app.
 *
 * Avatar accepts a URL (no storage bucket dependency — keeps this page
 * self-contained). Operators using GitHub/Gravatar can paste their image URL.
 */
import { useEffect, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { PlatformAdminAppLayout } from "@/apps/platform-admin/PlatformAdminAppLayout";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Loader2, ShieldCheck, KeyRound, User, Lock, Monitor } from "lucide-react";
import { toast } from "sonner";
import { Link } from "react-router-dom";
import { AdminPinCard } from "@/components/admin/AdminPinCard";
import { AdminSessionsCard } from "@/components/admin/AdminSessionsCard";

interface ProfileForm {
  full_name: string;
  avatar_url: string;
  phone: string;
}

export default function AdminProfile() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<ProfileForm>({
    full_name: "",
    avatar_url: "",
    phone: "",
  });

  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const { data } = await supabase
          .from("profiles")
          .select("full_name, avatar_url, phone")
          .eq("user_id", user.id)
          .maybeSingle();
        if (data) {
          setForm({
            full_name: data.full_name ?? "",
            avatar_url: data.avatar_url ?? "",
            phone: data.phone ?? "",
          });
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [user]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from("profiles")
        .upsert(
          {
            user_id: user.id,
            email: user.email ?? "",
            full_name: form.full_name.trim() || null,
            avatar_url: form.avatar_url.trim() || null,
            phone: form.phone.trim() || null,
          },
          { onConflict: "user_id" },
        );
      if (error) throw error;
      toast.success("Profile updated");
    } catch (err: any) {
      toast.error(normalizeError(err).message ?? "Could not save profile");
    } finally {
      setSaving(false);
    }
  };

  const initials = (form.full_name || user?.email || "?")
    .split(/\s+/)
    .map((s) => s[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <PlatformAdminAppLayout>
      <div className="p-3 sm:p-6 lg:p-8 max-w-3xl space-y-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">My profile</h1>
          <p className="text-sm text-muted-foreground">
            Manage how you appear to other admins, your quick-login PIN and
            active sessions.
          </p>
        </div>

        <Tabs defaultValue="profile" className="space-y-6">
          <TabsList>
            <TabsTrigger value="profile" className="gap-2">
              <User className="h-4 w-4" />
              Profile
            </TabsTrigger>
            <TabsTrigger value="security" className="gap-2">
              <ShieldCheck className="h-4 w-4" />
              Security
            </TabsTrigger>
            <TabsTrigger value="sessions" className="gap-2">
              <Monitor className="h-4 w-4" />
              Sessions
            </TabsTrigger>
          </TabsList>

          <TabsContent value="profile" className="space-y-6">
            <Card>
              <form onSubmit={handleSave}>
                <CardHeader>
                  <CardTitle>Personal details</CardTitle>
                  <CardDescription>
                    Your name appears in audit logs, ownership transfers and
                    team lists.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                  <div className="flex items-center gap-4">
                    <Avatar className="h-16 w-16">
                      <AvatarImage src={form.avatar_url || undefined} />
                      <AvatarFallback className="text-lg">
                        {initials}
                      </AvatarFallback>
                    </Avatar>
                    <div className="text-sm text-muted-foreground">
                      <div>
                        <strong>{user?.email ?? "—"}</strong>
                      </div>
                      <div>Email is managed by your auth provider.</div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="full_name">Full name</Label>
                    <Input
                      id="full_name"
                      value={form.full_name}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, full_name: e.target.value }))
                      }
                      placeholder="Jane Operator"
                      disabled={loading}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="avatar_url">Avatar URL (optional)</Label>
                    <Input
                      id="avatar_url"
                      value={form.avatar_url}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, avatar_url: e.target.value }))
                      }
                      placeholder="https://…/avatar.png"
                      disabled={loading}
                    />
                    <p className="text-xs text-muted-foreground">
                      Paste an image URL (Gravatar, GitHub, etc.). File upload
                      comes in a later release.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="phone">Phone (optional)</Label>
                    <Input
                      id="phone"
                      value={form.phone}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, phone: e.target.value }))
                      }
                      placeholder="+254 700 000 000"
                      disabled={loading}
                    />
                  </div>
                </CardContent>
                <CardFooter className="justify-end gap-2">
                  <Button type="submit" disabled={saving || loading}>
                    {saving && (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    )}
                    Save changes
                  </Button>
                </CardFooter>
              </form>
            </Card>
          </TabsContent>

          <TabsContent value="security" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <KeyRound className="h-5 w-5 text-primary" />
                  Two-factor authentication
                </CardTitle>
                <CardDescription>
                  Required for all platform admins. Add or rotate your TOTP
                  authenticator.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button variant="outline" asChild>
                  <Link to="/admin-management/mfa-setup">
                    <KeyRound className="h-4 w-4 mr-2" />
                    Manage 2FA
                  </Link>
                </Button>
              </CardContent>
            </Card>

            {/* PIN parity with tenant security: same hook, same guarantees,
                stronger because admins also enforce TOTP above. */}
            <AdminPinCard />
          </TabsContent>

          <TabsContent value="sessions" className="space-y-6">
            <AdminSessionsCard />
          </TabsContent>
        </Tabs>
      </div>
    </AdminDashboardLayout>
  );
}
