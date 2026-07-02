/**
 * Login Activity Card
 * Displays recent login history for the user
 */

import { format, formatDistanceToNow } from 'date-fns';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  History,
  CheckCircle,
  XCircle,
  AlertTriangle,
  MapPin,
  Clock,
  Globe,
  Key,
  Fingerprint,
  Mail,
  ExternalLink,
  Lock,
} from 'lucide-react';
import { useDeviceTracking, LoginHistoryEntry } from '@/hooks/security/useDeviceTracking';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';

interface LoginActivityCardProps {
  limit?: number;
  showViewAll?: boolean;
}

export function LoginActivityCard({ limit = 10, showViewAll = true }: LoginActivityCardProps) {
  const { loginHistory, isLoadingHistory } = useDeviceTracking();

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'success':
        return <CheckCircle className="h-4 w-4 text-primary" />;
      case 'failed':
        return <XCircle className="h-4 w-4 text-destructive" />;
      case 'blocked':
        return <Lock className="h-4 w-4 text-destructive" />;
      case 'locked_out':
        return <AlertTriangle className="h-4 w-4 text-muted-foreground" />;
      default:
        return <CheckCircle className="h-4 w-4 text-muted-foreground" />;
    }
  };

  const getMethodIcon = (method: string) => {
    switch (method) {
      case 'password':
        return <Key className="h-3 w-3" />;
      case 'pin':
        return <Fingerprint className="h-3 w-3" />;
      case 'magic_link':
        return <Mail className="h-3 w-3" />;
      default:
        return <Key className="h-3 w-3" />;
    }
  };

  const getStatusBadgeVariant = (status: string): "default" | "secondary" | "destructive" | "outline" => {
    switch (status) {
      case 'success':
        return 'default';
      case 'failed':
      case 'blocked':
        return 'destructive';
      case 'locked_out':
        return 'secondary';
      default:
        return 'outline';
    }
  };

  const displayedHistory = loginHistory?.slice(0, limit) || [];

  if (isLoadingHistory) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <History className="h-5 w-5" />
            Login Activity
          </CardTitle>
          <CardDescription>Loading activity...</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-start gap-3 p-3 border rounded-lg">
                <Skeleton className="h-8 w-8 rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-48" />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            <History className="h-5 w-5" />
            Login Activity
          </CardTitle>
          <CardDescription>
            Recent sign-in attempts to your account
          </CardDescription>
        </div>
        {showViewAll && loginHistory && loginHistory.length > limit && (
          <Button variant="ghost" size="sm" asChild>
            <Link to="/settings/security/activity">
              View All
              <ExternalLink className="h-3 w-3 ml-1" />
            </Link>
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {displayedHistory.length > 0 ? (
          <ScrollArea className="h-[400px] pr-4">
            <div className="space-y-3">
              {displayedHistory.map((entry) => (
                <div
                  key={entry.id}
                  className={cn(
                    "flex items-start gap-3 p-3 border rounded-lg",
                    entry.status !== 'success' && "bg-destructive/5 border-destructive/20"
                  )}
                >
                  <div className="flex items-center justify-center h-8 w-8 rounded-full bg-muted">
                    {getStatusIcon(entry.status)}
                  </div>

                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant={getStatusBadgeVariant(entry.status)}>
                        {entry.status}
                      </Badge>
                      <Badge variant="outline" className="text-xs">
                        {getMethodIcon(entry.login_method)}
                        <span className="ml-1 capitalize">{entry.login_method}</span>
                      </Badge>
                      {entry.is_new_device && (
                        <Badge variant="secondary" className="text-xs">
                          New Device
                        </Badge>
                      )}
                      {entry.is_new_location && (
                        <Badge variant="outline" className="text-xs">
                          New Location
                        </Badge>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {formatDistanceToNow(new Date(entry.created_at), { addSuffix: true })}
                      </span>
                      {entry.city && entry.country && (
                        <span className="flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          {entry.city}, {entry.country}
                        </span>
                      )}
                      {entry.ip_address && (
                        <span className="flex items-center gap-1">
                          <Globe className="h-3 w-3" />
                          {entry.ip_address}
                        </span>
                      )}
                    </div>

                    {entry.failure_reason && (
                      <p className="text-xs text-destructive">
                        {entry.failure_reason}
                      </p>
                    )}

                    <p className="text-xs text-muted-foreground">
                      {format(new Date(entry.created_at), 'MMM d, yyyy \'at\' h:mm a')}
                    </p>
                  </div>

                  {entry.risk_score !== null && entry.risk_score > 0 && (
                    <div className={cn(
                      "text-xs font-medium px-2 py-1 rounded",
                      entry.risk_score >= 50 ? "bg-destructive/10 text-destructive" :
                      entry.risk_score >= 25 ? "bg-secondary text-secondary-foreground" :
                      "bg-muted text-muted-foreground"
                    )}>
                      Risk: {entry.risk_score}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </ScrollArea>
        ) : (
          <div className="text-center py-8 text-muted-foreground">
            <History className="h-12 w-12 mx-auto mb-3 opacity-50" />
            <p>No login activity yet</p>
            <p className="text-sm">Your login history will appear here</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
