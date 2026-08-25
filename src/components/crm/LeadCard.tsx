// @ts-nocheck - Tables not in auto-generated types
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Calendar, Star, Clock, AlertCircle, Phone, Mail, Users, User } from "lucide-react";
import { format, isPast, isToday, isTomorrow, parseISO } from "date-fns";
import { Lead } from "@/hooks/crm/useLeads";
import { useCurrency } from "@/hooks/useCurrency";
import { useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";

export interface NextActivity {
  id: string;
  summary: string;
  activity_type: string | null;
  due_date: string | null;
  due_time: string | null;
}

interface LeadCardProps {
  lead: Lead;
  nextActivity?: NextActivity | null;
  assignedUserName?: string | null;
  onClick?: () => void;
}

export function LeadCard({ lead, nextActivity, assignedUserName, onClick }: LeadCardProps) {
  const { formatCurrency, baseCurrency } = useCurrency();
  const navigate = useNavigate();

  const getPriorityStars = (priority: number | null) => {
    return priority || 0;
  };

  const getActivityStatus = () => {
    if (!nextActivity?.due_date) return null;
    const dueDate = parseISO(nextActivity.due_date);
    if (isPast(dueDate) && !isToday(dueDate)) return "overdue";
    if (isToday(dueDate)) return "today";
    if (isTomorrow(dueDate)) return "tomorrow";
    return "scheduled";
  };

  const activityStatus = getActivityStatus();

  const getActivityIcon = () => {
    switch (nextActivity?.activity_type) {
      case "Call": return <Phone className="h-3 w-3" />;
      case "Email": return <Mail className="h-3 w-3" />;
      case "Meeting": return <Users className="h-3 w-3" />;
      default: return <Clock className="h-3 w-3" />;
    }
  };

  return (
    <Card 
      className={cn(
        "cursor-pointer hover:border-primary/50 transition-colors",
        activityStatus === "overdue" && "border-destructive/50",
        activityStatus === "today" && "border-primary/50"
      )}
      onClick={onClick}
    >
      <CardContent className="p-3 space-y-2">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <p className="font-medium text-sm line-clamp-1">{lead.name}</p>
            {lead.company_contact?.name && (
              <p className="text-xs text-muted-foreground">{lead.company_contact.name}</p>
            )}
          </div>
          <div className="flex">
            {[...Array(getPriorityStars(lead.priority))].map((_, i) => (
              <Star key={i} className="h-3 w-3 fill-yellow-400 text-yellow-400" />
            ))}
          </div>
        </div>

        {lead.expected_revenue && (
          <div className="flex items-center gap-1 text-xs">
            <span className="font-medium text-green-600">{formatCurrency(lead.expected_revenue, lead.currency || baseCurrency)}</span>
            {lead.probability != null && (
              <Badge variant="outline" className="text-xs ml-1">
                {lead.probability}%
              </Badge>
            )}
          </div>
        )}

        {/* Next Activity Indicator */}
        {nextActivity && (
          <div className={cn(
            "flex items-center gap-1.5 text-xs rounded-md px-2 py-1",
            activityStatus === "overdue" && "bg-destructive/10 text-destructive",
            activityStatus === "today" && "bg-primary/10 text-primary",
            activityStatus === "tomorrow" && "bg-amber-500/10 text-amber-600",
            activityStatus === "scheduled" && "bg-muted text-muted-foreground"
          )}>
            {activityStatus === "overdue" ? (
              <AlertCircle className="h-3 w-3" />
            ) : (
              getActivityIcon()
            )}
            <span className="truncate flex-1">{nextActivity.summary}</span>
            {nextActivity.due_date && (
              <span className="shrink-0">
                {activityStatus === "today" ? "Today" : 
                 activityStatus === "tomorrow" ? "Tomorrow" :
                 activityStatus === "overdue" ? "Overdue" :
                 format(parseISO(nextActivity.due_date), "MMM d")}
              </span>
            )}
          </div>
        )}

        <div className="flex items-center justify-between">
          {lead.contact_name && (
            <div className="flex items-center gap-2">
              <Avatar className="h-5 w-5">
                <AvatarFallback className="text-xs">
                  {lead.contact_name.split(" ").map(n => n[0]).join("").slice(0, 2)}
                </AvatarFallback>
              </Avatar>
              <span
                className={cn(
                  "text-xs text-muted-foreground truncate max-w-[100px]",
                  lead.contact_id && "hover:text-primary hover:underline cursor-pointer"
                )}
                onClick={lead.contact_id ? (e) => {
                  e.stopPropagation();
                  navigate(`/contacts-app/profile?id=${lead.contact_id}&from=crm`);
                } : undefined}
              >
                {lead.contact_name}
              </span>
            </div>
          )}
          {lead.expected_close_date && !nextActivity && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Calendar className="h-3 w-3" />
              {format(new Date(lead.expected_close_date), "MMM d")}
            </div>
          )}
        </div>

        {/* Assigned salesperson */}
        {assignedUserName && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <User className="h-3 w-3" />
            <span className="truncate">{assignedUserName}</span>
          </div>
        )}

        {lead.tags && lead.tags.length > 0 && (
          <div className="flex gap-1 flex-wrap">
            {lead.tags.slice(0, 2).map((tag) => (
              <Badge key={tag} variant="secondary" className="text-xs">
                {tag}
              </Badge>
            ))}
            {lead.tags.length > 2 && (
              <Badge variant="secondary" className="text-xs">
                +{lead.tags.length - 2}
              </Badge>
            )}
          </div>
        )}

        {/* Lost reason chip (shown on cards in a Lost stage). */}
        {lead.stage?.is_lost && lead.lost_reason?.name && (
          <div className="flex gap-1 flex-wrap">
            <Badge variant="outline" className="text-xs text-destructive border-destructive/40">
              Lost: {lead.lost_reason.name}
            </Badge>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
