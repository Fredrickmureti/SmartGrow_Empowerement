import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { toast } from "sonner";
import { Loader2, Plus, Trash2, Ban, Info } from "lucide-react";
import { normalizeE164 } from "@/lib/sms/phone";
import { normalizeError } from "@/services/resilience";

export default function SmsOptOutsPage() {
  const { currentOrg } = useOrganization();
  const queryClient = useQueryClient();
  const orgId = currentOrg?.id;
  const [newPhone, setNewPhone] = useState("");
  const [newReason, setNewReason] = useState("");

  const { data: optOuts = [], isLoading } = useQuery({
    queryKey: ["sms-opt-outs", orgId],
    queryFn: async () => {
      if (!orgId) return [];
      const { data, error } = await supabase
        .from("sms_opt_outs")
        .select("*")
        .eq("organization_id", orgId)
        .order("opted_out_at", { ascending: false });
      if (error) throw error;
      return data || [];
    },
    enabled: !!orgId,
  });

  const addOptOut = useMutation({
    mutationFn: async () => {
      if (!orgId || !newPhone) throw new Error("Missing data");
      const normalized = normalizeE164(newPhone);
      if (!normalized) throw new Error("Phone must be a valid E.164 number (e.g. +14155552671).");
      const { error } = await supabase.from("sms_opt_outs").insert([
        {
          organization_id: orgId,
          phone_number: normalized,
          reason: newReason || null,
        },
      ]);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sms-opt-outs", orgId] });
      setNewPhone("");
      setNewReason("");
      toast.success("Phone number added to opt-out list");
    },
    onError: (err: Error) => toast.error(normalizeError(err).message),
  });

  const removeOptOut = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("sms_opt_outs").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sms-opt-outs", orgId] });
      toast.success("Phone number removed from opt-out list");
    },
    onError: (err: Error) => toast.error(normalizeError(err).message),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl px-4 sm:px-0">
      <div>
        <h2 className="text-xl sm:text-2xl font-bold tracking-tight">SMS Opt-Outs</h2>
        <p className="text-sm text-muted-foreground">
          Manage phone numbers that have opted out of SMS notifications.
        </p>
      </div>

      <Alert>
        <Info className="h-4 w-4" />
        <AlertDescription>
          <p className="font-medium mb-1">STOP/HELP Compliance</p>
          <p className="text-sm">
            When using Twilio, recipients can text <strong>STOP</strong> to opt out and <strong>HELP</strong> for info. 
            Twilio handles these keywords automatically at the carrier level. This page tracks opt-outs 
            you manage manually within your system. Recipients who text STOP to Twilio are blocked at the carrier level 
            and do not need to be added here.
          </p>
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Plus className="h-5 w-5" />
            Add Opt-Out
          </CardTitle>
          <CardDescription>
            Manually add a phone number to the opt-out list. SMS will not be sent to opted-out numbers.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
            <div className="flex-1 space-y-2">
              <Label htmlFor="opt-out-phone">Phone Number</Label>
              <Input
                id="opt-out-phone"
                value={newPhone}
                onChange={(e) => setNewPhone(e.target.value)}
                placeholder="+1234567890"
              />
            </div>
            <div className="flex-1 space-y-2">
              <Label htmlFor="opt-out-reason">Reason (optional)</Label>
              <Input
                id="opt-out-reason"
                value={newReason}
                onChange={(e) => setNewReason(e.target.value)}
                placeholder="Customer request"
              />
            </div>
            <Button onClick={() => addOptOut.mutate()} disabled={!newPhone || addOptOut.isPending} className="w-full sm:w-auto">
              {addOptOut.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Add
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Ban className="h-5 w-5" />
            Opted-Out Numbers ({optOuts.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {optOuts.length === 0 ? (
            <p className="text-center text-muted-foreground py-8">
              No opt-outs recorded. Numbers will appear here when contacts opt out.
            </p>
          ) : (
            <div className="overflow-x-auto -mx-6">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Phone Number</TableHead>
                    <TableHead className="hidden sm:table-cell">Reason</TableHead>
                    <TableHead>Opted Out</TableHead>
                    <TableHead className="w-[60px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {optOuts.map((opt) => (
                    <TableRow key={opt.id}>
                      <TableCell className="font-mono text-xs sm:text-sm">{opt.phone_number}</TableCell>
                      <TableCell className="text-muted-foreground hidden sm:table-cell">{opt.reason || "—"}</TableCell>
                      <TableCell className="text-muted-foreground text-xs sm:text-sm">
                        {new Date(opt.opted_out_at).toLocaleDateString()}
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeOptOut.mutate(opt.id)}
                          disabled={removeOptOut.isPending}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
