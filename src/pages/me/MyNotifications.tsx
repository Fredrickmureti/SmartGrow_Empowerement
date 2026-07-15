/**
 * MyNotifications — inbox rendered INSIDE `MePortalLayout` at `/me/notifications`.
 *
 * The legacy `/notifications` route mounts `PlatformAppLayout` (business
 * shell), which is why clicking the portal's Notifications link used to
 * dump users out of the ESS chrome. This page reuses the same data hooks
 * and item components but renders inside the portal shell, so context is
 * preserved.
 */
import { useState } from "react";
import { Bell, CheckCheck, Filter, Search, Settings, Trash2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useNotifications, Notification } from "@/hooks/useNotifications";
import { NotificationItem } from "@/components/notifications/NotificationItem";
import { NotificationSettings } from "@/components/notifications/NotificationSettings";
import { PageHeader, PageBody } from "@/design-system";

export default function MyNotifications() {
  const { notifications, unreadCount, isLoading, markAllAsRead, clearAll, categories } =
    useNotifications({ skipRealtime: true });

  const [activeTab, setActiveTab] = useState("all");
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");
  const [type, setType] = useState("all");

  const filtered = notifications.filter((n) => {
    if (activeTab === "unread" && n.is_read) return false;
    if (activeTab === "read" && !n.is_read) return false;
    if (q) {
      const s = q.toLowerCase();
      if (!n.title.toLowerCase().includes(s) && !n.message.toLowerCase().includes(s)) return false;
    }
    if (cat !== "all" && n.category !== cat) return false;
    if (type !== "all" && n.type !== type) return false;
    return true;
  });

  return (
    <>
      <PageHeader
        title="Notifications"
        description={unreadCount > 0
          ? `You have ${unreadCount} unread notification${unreadCount !== 1 ? "s" : ""}`
          : "You're all caught up."}
        actions={
          <div className="flex items-center gap-2">
            {unreadCount > 0 && (
              <Button variant="outline" size="sm" onClick={() => markAllAsRead()}>
                <CheckCheck className="h-4 w-4 mr-2" /> Mark all read
              </Button>
            )}
            <Button variant="outline" size="sm" className="text-destructive" onClick={() => clearAll()}>
              <Trash2 className="h-4 w-4 mr-2" /> Clear all
            </Button>
          </div>
        }
      />
      <PageBody>
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
            <TabsList>
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="unread">
                Unread
                {unreadCount > 0 && (
                  <span className="ml-1.5 px-1.5 py-0.5 text-xs bg-primary text-primary-foreground rounded-full">
                    {unreadCount}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="read">Read</TabsTrigger>
              <TabsTrigger value="settings">
                <Settings className="h-4 w-4 mr-1" /> Settings
              </TabsTrigger>
            </TabsList>

            {activeTab !== "settings" && (
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-8 w-full sm:w-[200px]" />
                </div>
                <Select value={cat} onValueChange={setCat}>
                  <SelectTrigger className="w-full sm:w-[140px]"><Filter className="h-4 w-4 mr-2" /><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All categories</SelectItem>
                    {categories.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={type} onValueChange={setType}>
                  <SelectTrigger className="w-full sm:w-[110px]"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All types</SelectItem>
                    <SelectItem value="info">Info</SelectItem>
                    <SelectItem value="success">Success</SelectItem>
                    <SelectItem value="warning">Warning</SelectItem>
                    <SelectItem value="error">Error</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {(["all", "unread", "read"] as const).map((k) => (
            <TabsContent key={k} value={k} className="mt-0">
              <List items={filtered} isLoading={isLoading} />
            </TabsContent>
          ))}
          <TabsContent value="settings" className="mt-0"><NotificationSettings /></TabsContent>
        </Tabs>
      </PageBody>
    </>
  );
}

function List({ items, isLoading }: { items: Notification[]; isLoading: boolean }) {
  if (isLoading) return (
    <Card><CardContent className="flex items-center justify-center py-12">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
    </CardContent></Card>
  );
  if (!items.length) return (
    <Card><CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
      <Bell className="h-12 w-12 mb-4 opacity-50" />
      <p className="text-lg font-medium">No notifications</p>
      <p className="text-sm">Check back later for updates</p>
    </CardContent></Card>
  );
  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0 max-h-[600px] flex flex-col min-h-0">
        <ScrollArea className="flex-1 min-h-0">
          <div className="divide-y">
            {items.map((n) => <NotificationItem key={n.id} notification={n} />)}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
