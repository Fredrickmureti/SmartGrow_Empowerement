import { cn } from "@/lib/utils";
import { useNotifications, Notification } from "@/hooks/useNotifications";
import { Button } from "@/components/ui/button";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
  X,
  FileText,
  Package,
  DollarSign,
  Users,
  ShoppingCart,
  Settings,
  Clock,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useNavigate } from "react-router-dom";
import { LEGACY_ROUTE_MAPPINGS } from "@/lib/apps/registry";

interface NotificationItemProps {
  notification: Notification;
  onClose?: () => void;
}

const typeIcons = {
  info: Info,
  warning: AlertTriangle,
  error: AlertCircle,
  success: CheckCircle2,
};

const typeStyles = {
  info: "text-blue-500 bg-blue-500/10",
  warning: "text-yellow-500 bg-yellow-500/10",
  error: "text-red-500 bg-red-500/10",
  success: "text-green-500 bg-green-500/10",
};

const categoryIcons: Record<string, typeof Info> = {
  invoice: FileText,
  inventory: Package,
  payment: DollarSign,
  team: Users,
  pos: ShoppingCart,
  system: Settings,
  expense: DollarSign,
  attendance: Clock,
};

export function NotificationItem({ notification, onClose }: NotificationItemProps) {
  const { markAsRead, dismiss } = useNotifications({ skipRealtime: true });
  const navigate = useNavigate();

  const TypeIcon = typeIcons[notification.type] || Info;
  const CategoryIcon = categoryIcons[notification.category] || Info;

  const handleClick = () => {
    if (!notification.is_read) {
      markAsRead(notification.id);
    }
    
    if (notification.link) {
      // Translate legacy flat routes (e.g. "/invoices") to the live app
      // routes (e.g. "/sales/invoices"). Preserves any query/hash suffix.
      const raw = notification.link;
      const [pathOnly, suffix = ""] = raw.split(/(?=[?#])/, 2);
      const mapped = LEGACY_ROUTE_MAPPINGS[pathOnly];
      const target = mapped ? `${mapped}${suffix}` : raw;
      navigate(target);
      onClose?.();
    }
  };

  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    dismiss(notification.id);
  };

  return (
    <div
      className={cn(
        "group relative flex gap-3 p-3 hover:bg-muted/50 cursor-pointer transition-colors",
        !notification.is_read && "bg-muted/30",
        notification.priority > 0 && "border-l-2 border-l-primary"
      )}
      onClick={handleClick}
    >
      {/* Icon */}
      <div className={cn(
        "flex-shrink-0 h-8 w-8 rounded-full flex items-center justify-center",
        typeStyles[notification.type]
      )}>
        <TypeIcon className="h-4 w-4" />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <p className={cn(
              "text-sm font-medium truncate",
              !notification.is_read && "font-semibold"
            )}>
              {notification.title}
            </p>
            <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
              {notification.message}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 flex-shrink-0 opacity-0 group-hover:opacity-100 hover:opacity-100"
            onClick={handleDismiss}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>

        {/* Meta */}
        <div className="flex items-center gap-2 mt-1">
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <CategoryIcon className="h-3 w-3" />
            <span className="capitalize">{notification.category}</span>
          </div>
          <span className="text-muted-foreground">•</span>
          <span className="text-xs text-muted-foreground">
            {formatDistanceToNow(new Date(notification.created_at), { addSuffix: true })}
          </span>
        </div>
      </div>

      {/* Unread indicator */}
      {!notification.is_read && (
        <div className="absolute top-3 right-3 h-2 w-2 rounded-full bg-primary" />
      )}
    </div>
  );
}
