import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useNotifications } from "@/hooks/useNotifications";
import { useSmsEnabled } from "@/hooks/useSmsEnabled";
import { Bell, Mail, Smartphone, MessageSquare } from "lucide-react";

export function NotificationSettings() {
  const { categories, preferences, updatePreference, getPreference } = useNotifications({ skipRealtime: true });
  const { smsEnabled } = useSmsEnabled();

  const handleToggle = (
    category: string, 
    field: 'email_enabled' | 'push_enabled' | 'in_app_enabled' | 'sms_enabled', 
    value: boolean
  ) => {
    const currentPref = getPreference(category);
    updatePreference({
      category,
      email_enabled: field === 'email_enabled' ? value : (currentPref?.email_enabled ?? true),
      push_enabled: field === 'push_enabled' ? value : (currentPref?.push_enabled ?? true),
      in_app_enabled: field === 'in_app_enabled' ? value : (currentPref?.in_app_enabled ?? true),
      ...(smsEnabled ? { sms_enabled: field === 'sms_enabled' ? value : (currentPref?.sms_enabled ?? true) } : {}),
    });
  };

  const columnCount = smsEnabled ? 5 : 4;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="h-5 w-5" />
          Notification Preferences
        </CardTitle>
        <CardDescription>
          Choose how you want to be notified about different events.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          {/* Header row */}
          <div className={`grid grid-cols-${columnCount} gap-4 text-sm font-medium text-muted-foreground pb-2 border-b`}
            style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}
          >
            <div>Category</div>
            <div className="flex items-center justify-center gap-1">
              <Bell className="h-4 w-4" />
              <span className="hidden sm:inline">In-App</span>
            </div>
            <div className="flex items-center justify-center gap-1">
              <Mail className="h-4 w-4" />
              <span className="hidden sm:inline">Email</span>
            </div>
            <div className="flex items-center justify-center gap-1">
              <Smartphone className="h-4 w-4" />
              <span className="hidden sm:inline">Push</span>
            </div>
            {smsEnabled && (
              <div className="flex items-center justify-center gap-1">
                <MessageSquare className="h-4 w-4" />
                <span className="hidden sm:inline">SMS</span>
              </div>
            )}
          </div>

          {/* Category rows */}
          {categories.map((category) => {
            const pref = getPreference(category.value);
            const inAppEnabled = pref?.in_app_enabled ?? true;
            const emailEnabled = pref?.email_enabled ?? true;
            const pushEnabled = pref?.push_enabled ?? true;
            const smsOn = pref?.sms_enabled ?? true;

            return (
              <div 
                key={category.value} 
                className="grid gap-4 items-center py-2"
                style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))` }}
              >
                <Label className="font-medium">{category.label}</Label>
                
                <div className="flex justify-center">
                  <Switch
                    checked={inAppEnabled}
                    onCheckedChange={(checked) => 
                      handleToggle(category.value, 'in_app_enabled', checked)
                    }
                    aria-label={`${category.label} in-app notifications`}
                  />
                </div>
                
                <div className="flex justify-center">
                  <Switch
                    checked={emailEnabled}
                    onCheckedChange={(checked) => 
                      handleToggle(category.value, 'email_enabled', checked)
                    }
                    aria-label={`${category.label} email notifications`}
                  />
                </div>
                
                <div className="flex justify-center">
                  <Switch
                    checked={pushEnabled}
                    onCheckedChange={(checked) => 
                      handleToggle(category.value, 'push_enabled', checked)
                    }
                    aria-label={`${category.label} push notifications`}
                  />
                </div>

                {smsEnabled && (
                  <div className="flex justify-center">
                    <Switch
                      checked={smsOn}
                      onCheckedChange={(checked) => 
                        handleToggle(category.value, 'sms_enabled', checked)
                      }
                      aria-label={`${category.label} SMS notifications`}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
