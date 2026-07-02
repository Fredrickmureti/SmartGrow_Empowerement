/**
 * AttendanceDevices — hardware terminal registry.
 *
 * Register ZKTeco/Hikvision/Suprema/RFID/kiosk terminals. The HMAC secret
 * is returned ONCE on registration and used by the terminal to sign
 * requests to /api/public/attendance/ingest.
 */
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Loader2, Plus, Copy, AlertTriangle, Cpu } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { AttendanceFormShell } from "@/components/attendance/_shared/AttendanceFormShell";
import { WorkflowSheetGrid, WorkflowSheetSection, WorkflowField } from "@/components/workflow/WorkflowSheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAttendanceDevices } from "@/hooks/hr/useAttendanceDevices";
import { useBranches } from "@/hooks/useBranches";
import { toast } from "sonner";
import { deviceHealth, deviceHealthBadgeClass, isDeviceStale } from "@/lib/attendance/deviceHealth";
import { EmptyStateRail } from "@/components/attendance/EmptyStateRail";

const VENDORS = ["zkteco", "hikvision", "suprema", "rfid", "kiosk", "other"];

const statusColor: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30",
  disabled: "bg-muted text-muted-foreground border-border",
  revoked: "bg-rose-500/15 text-rose-700 border-rose-500/30",
};

export default function AttendanceDevices() {
  const { devices, isLoading, register, isRegistering, setStatus, isUpdatingStatus } = useAttendanceDevices();
  const { branches } = useBranches();
  const [searchParams, setSearchParams] = useSearchParams();
  const filter = searchParams.get("filter"); // "stale" | null
  const [open, setOpen] = useState(false);
  const [vendor, setVendor] = useState("zkteco");
  const [serial, setSerial] = useState("");
  const [branchId, setBranchId] = useState<string>("");
  const [secret, setSecret] = useState<{ public_id: string; hmac_secret_hex: string } | null>(null);

  /**
   * Filter applied to the rendered table. The `stale` filter is wired to the
   * Attendance inbox card's "Devices silent >24h" row so HR can jump from
   * the inbox directly into the offending terminals.
   */
  const visibleDevices = useMemo(() => {
    if (filter === "stale") {
      return devices.filter((d) => d.status === "active" && isDeviceStale(d.last_seen_at));
    }
    return devices;
  }, [devices, filter]);

  const clearFilter = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("filter");
    setSearchParams(next, { replace: true });
  };

  const handleRegister = async () => {
    if (!serial.trim()) {
      toast.error("Serial is required");
      return;
    }
    const result = await register({
      vendor,
      serial: serial.trim(),
      branch_id: branchId || null,
    });
    setSecret(result);
    setSerial("");
    setBranchId("");
    setOpen(false);
  };

  const copy = (text: string) => {
    navigator.clipboard.writeText(text);
    toast.success("Copied to clipboard");
  };

  return (
    <div className="space-y-4">
      <div className="page-header">
        <div>
          <h1 className="page-title">Attendance Devices</h1>
          <p className="text-sm text-muted-foreground">
            Hardware terminals authorized to ingest clock events via{" "}
            <code className="text-xs">/api/public/attendance/ingest</code>.
          </p>
        </div>
        <div className="action-buttons">
          <Button onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> Register device
          </Button>
        </div>
      </div>

      {filter === "stale" && (
        <div className="flex items-center justify-between rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs">
          <span>
            Showing <strong>{visibleDevices.length}</strong> active
            terminal{visibleDevices.length === 1 ? "" : "s"} that haven't
            pinged in 24 h.
          </span>
          <Button size="sm" variant="ghost" onClick={clearFilter}>
            Show all
          </Button>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {filter === "stale"
              ? `${visibleDevices.length} silent of ${devices.length}`
              : `${devices.length} registered`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : devices.length === 0 ? (
            <EmptyStateRail
              icon={Cpu}
              headline="No attendance terminals yet"
              steps={[
                "Register the first device to receive a one-time HMAC secret.",
                "Configure the terminal to POST to /api/public/attendance/ingest using that secret.",
                "Issue employees an external_attendance_ref so taps can resolve them.",
              ]}
              cta={{ label: "Register device", onClick: () => setOpen(true) }}
            />
          ) : visibleDevices.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No devices match the current filter.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-2">Vendor</th>
                    <th className="py-2 pr-2">Serial</th>
                    <th className="py-2 pr-2">Public ID</th>
                    <th className="py-2 pr-2">Branch</th>
                    <th className="py-2 pr-2">Last seen</th>
                    <th className="py-2 pr-2">Health</th>
                    <th className="py-2 pr-2">Status</th>
                    <th className="py-2 pr-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleDevices.map((d) => {
                    const health = deviceHealth(d.last_seen_at);
                    return (
                      <tr key={d.id} className="border-b last:border-0">
                        <td className="py-2 pr-2 capitalize">{d.vendor}</td>
                        <td className="py-2 pr-2 font-mono text-xs">{d.serial}</td>
                        <td className="py-2 pr-2 font-mono text-xs">
                          <button
                            className="hover:underline"
                            onClick={() => copy(d.public_id)}
                            title="Click to copy"
                          >
                            {d.public_id.slice(0, 12)}…
                          </button>
                        </td>
                        <td className="py-2 pr-2 text-xs">
                          {branches.find((b) => b.id === d.branch_id)?.name ?? "—"}
                        </td>
                        <td className="py-2 pr-2 text-xs text-muted-foreground">
                          {d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : "Never"}
                        </td>
                        <td className="py-2 pr-2">
                          <Badge
                            variant="outline"
                            className={deviceHealthBadgeClass[health.tone]}
                            title={
                              d.last_seen_at
                                ? `Last seen ${new Date(d.last_seen_at).toLocaleString()}`
                                : "Never pinged"
                            }
                          >
                            {health.label}
                          </Badge>
                        </td>
                        <td className="py-2 pr-2">
                          <Badge variant="outline" className={statusColor[d.status]}>
                            {d.status}
                          </Badge>
                        </td>
                        <td className="py-2 pr-2 text-right">
                          <div className="flex justify-end gap-1">
                            {d.status !== "active" && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={isUpdatingStatus}
                                onClick={() => setStatus({ id: d.id, status: "active" })}
                              >
                                Enable
                              </Button>
                            )}
                            {d.status === "active" && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={isUpdatingStatus}
                                onClick={() => setStatus({ id: d.id, status: "disabled" })}
                              >
                                Disable
                              </Button>
                            )}
                            {d.status !== "revoked" && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={isUpdatingStatus}
                                onClick={() => setStatus({ id: d.id, status: "revoked" })}
                              >
                                Revoke
                              </Button>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Register sheet */}
      <AttendanceFormShell
        open={open}
        onOpenChange={setOpen}
        entity="device"
        description="The HMAC secret will be shown once after registration. Copy it then — it cannot be retrieved again."
        busy={isRegistering}
        submitLabel="Register"
        submitDisabled={!serial.trim()}
        onSubmit={handleRegister}
      >
        <WorkflowSheetSection number={1} title="Device" subtitle="Vendor and serial identify the terminal in audit logs.">
          <WorkflowSheetGrid>
            <WorkflowField label="Vendor" required>
              <select
                className="w-full h-10 rounded-md border bg-background px-3 text-sm"
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
              >
                {VENDORS.map((v) => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            </WorkflowField>
            <WorkflowField label="Serial" required>
              <Input value={serial} onChange={(e) => setSerial(e.target.value)} placeholder="Device serial number" />
            </WorkflowField>
          </WorkflowSheetGrid>
        </WorkflowSheetSection>
        <WorkflowSheetSection number={2} title="Location" subtitle="Pin the device to a branch so punches resolve to the right context.">
          <WorkflowField label="Branch">
            <select
              className="w-full h-10 rounded-md border bg-background px-3 text-sm"
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
            >
              <option value="">No branch</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </WorkflowField>
        </WorkflowSheetSection>
      </AttendanceFormShell>

      {/* Secret reveal dialog (shown ONCE) */}
      <Dialog open={!!secret} onOpenChange={(o) => !o && setSecret(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" />
              Save this HMAC secret now
            </DialogTitle>
            <DialogDescription>
              This is the only time the secret will be displayed. Configure your terminal
              with both values, then close this dialog.
            </DialogDescription>
          </DialogHeader>
          {secret && (
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label>Device public ID</Label>
                <div className="flex gap-2">
                  <Input readOnly value={secret.public_id} className="font-mono text-xs" />
                  <Button variant="outline" size="icon" onClick={() => copy(secret.public_id)}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>HMAC secret (hex)</Label>
                <div className="flex gap-2">
                  <Input readOnly value={secret.hmac_secret_hex} className="font-mono text-xs" />
                  <Button variant="outline" size="icon" onClick={() => copy(secret.hmac_secret_hex)}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Terminal POSTs to <code>/api/public/attendance/ingest</code> with headers{" "}
                <code>x-device-id</code>, <code>x-timestamp</code>, and{" "}
                <code>x-signature</code> (hex HMAC-SHA256 of the raw body using this secret).
              </p>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setSecret(null)}>Done — I've saved it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
