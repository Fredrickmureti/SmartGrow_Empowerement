import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useNotifications } from "@/hooks/useNotifications";
import { NotificationItem } from "./NotificationItem";
import { Bell, CheckCheck, Settings, Trash2 } from "lucide-react";
import { Link } from "react-router-dom";
import { useSession } from "@/contexts/SessionContext";

interface NotificationPopoverProps {
  onClose: () => void;
}

export function NotificationPopover({ onClose }: NotificationPopoverProps) {
  const { userType } = useSession();
  const settingsHref = userType === "portal" ? "/me/settings" : "/settings?tab=notifications";
  const { 
    notifications, 
    unreadCount, 
    isLoading, 
    markAllAsRead, 
    clearAll 
  } = useNotifications({ skipRealtime: true });

  return (
    <div className="flex flex-col h-[400px] max-h-[70vh] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0 bg-popover">
        <div className="flex items-center gap-2">
          <Bell className="h-4 w-4" />
          <h3 className="font-semibold">Notifications</h3>
          {unreadCount > 0 && (
            <span className="text-xs text-muted-foreground">
              ({unreadCount} unread)
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {unreadCount > 0 && (
            <Button 
              variant="ghost" 
              size="sm" 
              className="h-8 px-2"
              onClick={() => markAllAsRead()}
            >
              <CheckCheck className="h-4 w-4 mr-1" />
              <span className="hidden sm:inline">Mark all read</span>
            </Button>
          )}
          <Link to={settingsHref} onClick={onClose}>
            <Button variant="ghost" size="icon" className="h-8 w-8">
              <Settings className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </div>

      {/* Notification List */}
      <ScrollArea className="flex-1 min-h-0">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
          </div>
        ) : notifications.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <Bell className="h-10 w-10 mb-2 opacity-50" />
            <p className="text-sm">No notifications</p>
            <p className="text-xs">You're all caught up!</p>
          </div>
        ) : (
          <div className="divide-y">
            {notifications.map((notification) => (
              <NotificationItem 
                key={notification.id} 
                notification={notification}
                onClose={onClose}
              />
            ))}
          </div>
        )}
      </ScrollArea>

      {/* Footer */}
      {notifications.length > 0 && (
        <>
          <Separator />
          <div className="p-2 flex justify-between">
            <Button 
              variant="ghost" 
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => clearAll()}
            >
              <Trash2 className="h-4 w-4 mr-1" />
              Clear all
            </Button>
            <Link to="/notifications" onClick={onClose}>
              <Button variant="ghost" size="sm">
                View all
              </Button>
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
