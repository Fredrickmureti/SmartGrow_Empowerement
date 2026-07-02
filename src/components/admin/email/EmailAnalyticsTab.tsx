// @ts-nocheck - Admin tables not in auto-generated types
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { Loader2, BarChart3, Send, Eye, AlertCircle, TrendingUp } from "lucide-react";
import { format, subDays, eachDayOfInterval } from "date-fns";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from "recharts";

interface EmailStats {
  totalSent: number;
  totalOpened: number;
  totalFailed: number;
  openRate: number;
  recentEmails: number;
}

interface DailyStats {
  date: string;
  sent: number;
  opened: number;
  failed: number;
}

export function EmailAnalyticsTab() {
  const { toast } = useToast();
  const [stats, setStats] = useState<EmailStats | null>(null);
  const [dailyStats, setDailyStats] = useState<DailyStats[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetchStats();
  }, []);

  const fetchStats = async () => {
    try {
      const { data: logs, error } = await supabase
        .from("platform_email_logs")
        .select("status, sent_at, opened_at, created_at");

      if (error) throw error;

      const allLogs = logs || [];
      const thirtyDaysAgo = subDays(new Date(), 30);
      
      const totalSent = allLogs.filter(l => l.status === "sent").length;
      const totalOpened = allLogs.filter(l => l.opened_at).length;
      const totalFailed = allLogs.filter(l => l.status === "failed").length;
      const recentEmails = allLogs.filter(l => l.sent_at && new Date(l.sent_at) > thirtyDaysAgo).length;

      setStats({
        totalSent,
        totalOpened,
        totalFailed,
        openRate: totalSent > 0 ? Math.round((totalOpened / totalSent) * 100) : 0,
        recentEmails,
      });

      // Calculate daily stats for the chart
      const days = eachDayOfInterval({
        start: subDays(new Date(), 30),
        end: new Date(),
      });

      const dailyData = days.map(day => {
        const dayStr = format(day, "yyyy-MM-dd");
        const dayLogs = allLogs.filter(l => {
          const logDate = l.sent_at || l.created_at;
          return logDate && format(new Date(logDate), "yyyy-MM-dd") === dayStr;
        });

        return {
          date: format(day, "MMM d"),
          sent: dayLogs.filter(l => l.status === "sent").length,
          opened: dayLogs.filter(l => l.opened_at).length,
          failed: dayLogs.filter(l => l.status === "failed").length,
        };
      });

      setDailyStats(dailyData);
    } catch (error) {
      console.error("Error fetching stats:", error);
      toast({
        title: "Error",
        description: "Failed to load analytics",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Sent</CardTitle>
            <Send className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.totalSent || 0}</div>
            <p className="text-xs text-muted-foreground">All time</p>
          </CardContent>
        </Card>
        
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Opened</CardTitle>
            <Eye className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.totalOpened || 0}</div>
            <p className="text-xs text-muted-foreground">
              {stats?.openRate || 0}% open rate
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Failed</CardTitle>
            <AlertCircle className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-destructive">{stats?.totalFailed || 0}</div>
            <p className="text-xs text-muted-foreground">Delivery failures</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Recent (30d)</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{stats?.recentEmails || 0}</div>
            <p className="text-xs text-muted-foreground">Last 30 days</p>
          </CardContent>
        </Card>
      </div>

      {/* Email Volume Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <BarChart3 className="h-5 w-5" />
            Email Volume (Last 30 Days)
          </CardTitle>
          <CardDescription>
            Daily email send volume and open rates
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={dailyStats}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis 
                  dataKey="date" 
                  className="text-xs"
                  tick={{ fill: 'hsl(var(--muted-foreground))' }}
                />
                <YAxis 
                  className="text-xs"
                  tick={{ fill: 'hsl(var(--muted-foreground))' }}
                />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '8px',
                  }}
                />
                <Area 
                  type="monotone" 
                  dataKey="sent" 
                  stackId="1"
                  stroke="hsl(var(--primary))" 
                  fill="hsl(var(--primary))" 
                  fillOpacity={0.6}
                  name="Sent"
                />
                <Area 
                  type="monotone" 
                  dataKey="opened" 
                  stackId="2"
                  stroke="hsl(142.1 76.2% 36.3%)" 
                  fill="hsl(142.1 76.2% 36.3%)" 
                  fillOpacity={0.6}
                  name="Opened"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {/* Delivery Performance Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Delivery Performance</CardTitle>
          <CardDescription>
            Successful vs failed email deliveries
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dailyStats.slice(-14)}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis 
                  dataKey="date" 
                  className="text-xs"
                  tick={{ fill: 'hsl(var(--muted-foreground))' }}
                />
                <YAxis 
                  className="text-xs"
                  tick={{ fill: 'hsl(var(--muted-foreground))' }}
                />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '8px',
                  }}
                />
                <Bar dataKey="sent" fill="hsl(var(--primary))" name="Sent" radius={[4, 4, 0, 0]} />
                <Bar dataKey="failed" fill="hsl(var(--destructive))" name="Failed" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
