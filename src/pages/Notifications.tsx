import { PlatformAppLayout } from "@/apps/platform";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { useNotifications, Notification } from "@/hooks/useNotifications";
import { NotificationItem } from "@/components/notifications/NotificationItem";
import { NotificationSettings } from "@/components/notifications/NotificationSettings";
import { Bell, CheckCheck, Filter, Search, Settings, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export default function Notifications() {
  // skipRealtime: NotificationBell (always mounted in app shell) already
  // owns the realtime channel. Mounting another here would open a second
  // duplicate channel and double the invalidation work for every notification.
  const {
    notifications,
    unreadCount,
    isLoading,
    markAllAsRead,
    clearAll,
    categories
  } = useNotifications({ skipRealtime: true });
  
  const [activeTab, setActiveTab] = useState("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");

  // Filter notifications
  const filteredNotifications = notifications.filter((n) => {
    // Tab filter
    if (activeTab === "unread" && n.is_read) return false;
    if (activeTab === "read" && !n.is_read) return false;
    
    // Search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      if (!n.title.toLowerCase().includes(query) && !n.message.toLowerCase().includes(query)) {
        return false;
      }
    }
    
    // Category filter
    if (categoryFilter !== "all" && n.category !== categoryFilter) return false;
    
    // Type filter
    if (typeFilter !== "all" && n.type !== typeFilter) return false;
    
    return true;
  });

  return (
    <PlatformAppLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h1 className="page-title flex items-center gap-2">
              <Bell className="h-6 w-6" />
              Notifications
            </h1>
            <p className="text-muted-foreground">
              {unreadCount > 0 
                ? `You have ${unreadCount} unread notification${unreadCount !== 1 ? 's' : ''}`
                : "You're all caught up!"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {unreadCount > 0 && (
              <Button variant="outline" size="sm" onClick={() => markAllAsRead()}>
                <CheckCheck className="h-4 w-4 mr-2" />
                Mark all read
              </Button>
            )}
            <Button 
              variant="outline" 
              size="sm" 
              className="text-destructive"
              onClick={() => clearAll()}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              Clear all
            </Button>
          </div>
        </div>

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
                <Settings className="h-4 w-4 mr-1" />
                Settings
              </TabsTrigger>
            </TabsList>

            {/* Filters */}
            {activeTab !== "settings" && (
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 w-full sm:w-auto">
                <div className="relative">
                  <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search notifications..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-8 w-full sm:w-[200px]"
                  />
                </div>
                <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                  <SelectTrigger className="w-full sm:w-[130px]">
                    <Filter className="h-4 w-4 mr-2" />
                    <SelectValue placeholder="Category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Categories</SelectItem>
                    {categories.map((cat) => (
                      <SelectItem key={cat.value} value={cat.value}>
                        {cat.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={typeFilter} onValueChange={setTypeFilter}>
                  <SelectTrigger className="w-full sm:w-[110px]">
                    <SelectValue placeholder="Type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Types</SelectItem>
                    <SelectItem value="info">Info</SelectItem>
                    <SelectItem value="success">Success</SelectItem>
                    <SelectItem value="warning">Warning</SelectItem>
                    <SelectItem value="error">Error</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          <TabsContent value="all" className="mt-0">
            <NotificationList 
              notifications={filteredNotifications} 
              isLoading={isLoading} 
            />
          </TabsContent>
          
          <TabsContent value="unread" className="mt-0">
            <NotificationList 
              notifications={filteredNotifications} 
              isLoading={isLoading} 
            />
          </TabsContent>
          
          <TabsContent value="read" className="mt-0">
            <NotificationList 
              notifications={filteredNotifications} 
              isLoading={isLoading} 
            />
          </TabsContent>
          
          <TabsContent value="settings" className="mt-0">
            <NotificationSettings />
          </TabsContent>
        </Tabs>
      </div>
    </PlatformAppLayout>
  );
}

function NotificationList({ 
  notifications, 
  isLoading 
}: { 
  notifications: Notification[]; 
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </CardContent>
      </Card>
    );
  }

  if (notifications.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <Bell className="h-12 w-12 mb-4 opacity-50" />
          <p className="text-lg font-medium">No notifications</p>
          <p className="text-sm">Check back later for updates</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0 max-h-[600px] flex flex-col min-h-0">
        <ScrollArea className="flex-1 min-h-0">
          <div className="divide-y">
            {notifications.map((notification) => (
              <NotificationItem 
                key={notification.id} 
                notification={notification} 
              />
            ))}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
