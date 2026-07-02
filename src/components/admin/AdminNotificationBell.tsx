import { useState } from "react";
import { Bell, CheckCheck, Trash2, UserPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useAdminNotifications, AdminNotification } from "@/hooks/useAdminNotifications";
import { cn } from "@/lib/utils";
import { formatDistanceToNow } from "date-fns";
import { useNavigate } from "react-router-dom";

function NotificationIcon({ category }: { category: string }) {
  switch (category) {
    case "signup":
      return <UserPlus className="h-4 w-4 text-primary" />;
    default:
      return <Bell className="h-4 w-4 text-muted-foreground" />;
  }
}

function AdminNotificationItem({
  notification,
  onRead,
  onDismiss,
  onNavigate,
}: {
  notification: AdminNotification;
  onRead: (id: string) => void;
  onDismiss: (id: string) => void;
  onNavigate: (link: string) => void;
}) {
  return (
    <div
      className={cn(
        "group flex items-start gap-3 p-3 rounded-lg transition-colors cursor-pointer hover:bg-muted/50",
        !notification.is_read && "bg-primary/5"
      )}
      onClick={() => {
        if (!notification.is_read) onRead(notification.id);
        if (notification.link) onNavigate(notification.link);
      }}
    >
      <div className="mt-0.5 flex-shrink-0">
        <NotificationIcon category={notification.category} />
      </div>
      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <p className={cn("text-sm leading-tight", !notification.is_read && "font-semibold")}>
            {notification.title}
          </p>
          {!notification.is_read && (
            <span className="h-2 w-2 rounded-full bg-primary flex-shrink-0" />
          )}
        </div>
        <p className="text-xs text-muted-foreground leading-snug line-clamp-2">
          {notification.message}
        </p>
        <p className="text-[11px] text-muted-foreground/70">
          {formatDistanceToNow(new Date(notification.created_at), { addSuffix: true })}
        </p>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
        onClick={(e) => {
          e.stopPropagation();
          onDismiss(notification.id);
        }}
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  );
}

export function AdminNotificationBell() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const {
    notifications,
    unreadCount,
    markAsRead,
    markAllAsRead,
    dismiss,
    dismissAll,
  } = useAdminNotifications();

  const handleNavigate = (link: string) => {
    setOpen(false);
    navigate(link);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <Bell className="h-5 w-5" />
          {unreadCount > 0 && (
            <Badge
              variant="destructive"
              className="absolute -top-1 -right-1 h-5 min-w-5 px-1 flex items-center justify-center text-[10px] font-bold rounded-full"
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </Badge>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b">
          <h4 className="font-semibold text-sm">Admin Notifications</h4>
          <div className="flex items-center gap-1">
            {unreadCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs gap-1"
                onClick={() => markAllAsRead.mutate()}
              >
                <CheckCheck className="h-3 w-3" />
                Read all
              </Button>
            )}
            {notifications.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs gap-1 text-destructive hover:text-destructive"
                onClick={() => dismissAll.mutate()}
              >
                <Trash2 className="h-3 w-3" />
                Clear
              </Button>
            )}
          </div>
        </div>

        {/* Notification List */}
        <ScrollArea className="max-h-[400px]">
          {notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
              <Bell className="h-10 w-10 text-muted-foreground/30 mb-3" />
              <p className="text-sm text-muted-foreground">No notifications yet</p>
              <p className="text-xs text-muted-foreground/70 mt-1">
                You'll be notified when new users sign up
              </p>
            </div>
          ) : (
            <div className="p-2 space-y-1">
              {notifications.map((n) => (
                <AdminNotificationItem
                  key={n.id}
                  notification={n}
                  onRead={(id) => markAsRead.mutate(id)}
                  onDismiss={(id) => dismiss.mutate(id)}
                  onNavigate={handleNavigate}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
