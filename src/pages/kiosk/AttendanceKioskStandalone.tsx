/**
 * AttendanceKioskStandalone — chrome-less, top-level kiosk for shared devices.
 *
 * Mounted at /kiosk/attendance OUTSIDE of HrAppShell / AppSidebar / topbar so
 * the page renders edge-to-edge on a wall-mounted tablet. Org + branch are
 * resolved from a one-time "device pin" stored in localStorage so the kiosk
 * does not depend on whoever last logged in.
 *
 * Auth is still required (the underlying RPC uses session context); admins
 * sign in once on the device, then the screen stays on this route.
 *
 * Idle PIN-clear: 8s of inactivity blanks the PIN field to prevent
 * shoulder-surfed accumulation.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
// SCOPE-TRIGGER-EXEMPT: kiosk pairing branch picker, not the in-app scope switcher
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LogIn, Loader2, Delete, Settings2, ShieldCheck } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useBranches } from "@/hooks/useBranches";
import { useKioskClock } from "@/hooks/hr/useKioskClock";
import { Navigate } from "react-router-dom";

interface DevicePin {
  orgId: string;
  orgName: string;
  businessId: string | null;
  businessName: string | null;
  branchId: string;
  branchName: string;
}

const STORAGE_KEY = "attendance.kiosk.devicePin.v1";

/** Wipe the PIN this fast (typo / shoulder-surf protection). */
const PIN_IDLE_MS = 8_000;
/**
 * Full kiosk lock — wipe both PIN and employee number after this much
 * idle time. Configurable via VITE_KIOSK_IDLE_LOCK_MS so a deployment
 * can tune it without a code change. Default 60s.
 */
const idleTimeoutMs = Number(
  (import.meta as any).env?.VITE_KIOSK_IDLE_LOCK_MS ?? 60_000,
);

function readPin(): DevicePin | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as DevicePin) : null;
  } catch {
    return null;
  }
}

export default function AttendanceKioskStandalone() {
  const { user, isLoading: loading } = useAuth();
  const [device, setDevice] = useState<DevicePin | null>(() => readPin());
  const [setupOpen, setSetupOpen] = useState(false);
  const [employeeNumber, setEmployeeNumber] = useState("");
  const [pin, setPin] = useState("");
  const pinIdleRef = useRef<number | null>(null);
  const lockIdleRef = useRef<number | null>(null);

  const clock = useKioskClock(device?.orgId, device?.branchId);

  // Fast PIN clear — every keystroke restarts the 8s timer.
  useEffect(() => {
    if (!pin) return;
    if (pinIdleRef.current) window.clearTimeout(pinIdleRef.current);
    pinIdleRef.current = window.setTimeout(() => setPin(""), PIN_IDLE_MS);
    return () => {
      if (pinIdleRef.current) window.clearTimeout(pinIdleRef.current);
    };
  }, [pin]);

  // Full lock — any activity (touch / key / click) resets the longer
  // timer; when it fires we wipe both the PIN and the employee number so
  // the next person walking up starts from a clean slate.
  useEffect(() => {
    const reset = () => {
      if (lockIdleRef.current) window.clearTimeout(lockIdleRef.current);
      lockIdleRef.current = window.setTimeout(() => {
        setPin("");
        setEmployeeNumber("");
      }, idleTimeoutMs);
    };
    reset();
    const events: (keyof WindowEventMap)[] = [
      "touchstart",
      "keydown",
      "mousedown",
      "pointerdown",
    ];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    return () => {
      if (lockIdleRef.current) window.clearTimeout(lockIdleRef.current);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!user) return <Navigate to="/login?next=/kiosk/attendance" replace />;

  const press = (d: string) => setPin((p) => (p.length >= 8 ? p : p + d));
  const back = () => setPin((p) => p.slice(0, -1));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!employeeNumber.trim() || pin.length < 4 || !device) return;
    clock.mutate(
      { employeeNumber: employeeNumber.trim(), pin },
      {
        onSettled: () => {
          setPin("");
          // Keep employee number a moment so admins can correct typos, then clear.
          window.setTimeout(() => setEmployeeNumber(""), 1500);
        },
      },
    );
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Minimal top strip — branch identity + setup, no app chrome */}
      <header className="px-4 py-3 flex items-center justify-between border-b">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ShieldCheck className="h-4 w-4 text-primary" />
          <span className="font-medium text-foreground">Attendance Kiosk</span>
          {device && (
            <span className="hidden sm:inline">
              · {device.orgName}
              {device.businessName ? ` · ${device.businessName}` : ""} · {device.branchName}
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSetupOpen(true)}
          aria-label="Pin device to branch"
        >
          <Settings2 className="h-4 w-4 mr-1.5" />
          Pin device
        </Button>
      </header>

      <main className="flex-1 flex items-center justify-center p-4">
        {!device ? (
          <Card className="max-w-md w-full border-2">
            <CardContent className="p-8 text-center space-y-4">
              <div className="mx-auto h-12 w-12 rounded-full bg-amber-500/10 flex items-center justify-center">
                <Settings2 className="h-6 w-6 text-amber-600" />
              </div>
              <h1 className="text-xl font-semibold">Pin this device first</h1>
              <p className="text-sm text-muted-foreground">
                Choose the organization, business and branch this kiosk is physically located at.
                The selection is stored on this device only.
              </p>
              <Button onClick={() => setSetupOpen(true)}>Pin device to branch</Button>
            </CardContent>
          </Card>
        ) : (
          <Card className="w-full max-w-md border-2">
            <CardContent className="p-6 sm:p-8 space-y-6">
              <div className="text-center">
                <div className="mx-auto h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center mb-3">
                  <LogIn className="h-6 w-6 text-primary" />
                </div>
                <h1 className="text-2xl font-bold">Clock in / out</h1>
                <p className="text-sm text-muted-foreground">
                  {device.branchName}
                </p>
              </div>

              <form onSubmit={submit} className="space-y-4">
                <div className="space-y-1.5">
                  <Label>Employee number</Label>
                  <Input
                    value={employeeNumber}
                    onChange={(e) => setEmployeeNumber(e.target.value)}
                    placeholder="e.g. EMP-0042"
                    autoComplete="off"
                    autoFocus
                  />
                </div>

                <div className="space-y-1.5">
                  <Label>PIN</Label>
                  <Input
                    type="password"
                    inputMode="numeric"
                    value={pin}
                    readOnly
                    placeholder="••••"
                    className="text-center text-2xl tracking-[0.5em]"
                  />
                </div>

                <div className="grid grid-cols-3 gap-2">
                  {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
                    <Button
                      key={d}
                      type="button"
                      variant="outline"
                      size="lg"
                      className="h-14 text-xl"
                      onClick={() => press(d)}
                    >
                      {d}
                    </Button>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    className="h-14"
                    onClick={back}
                    aria-label="Backspace"
                  >
                    <Delete className="h-5 w-5" />
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    className="h-14 text-xl"
                    onClick={() => press("0")}
                  >
                    0
                  </Button>
                  <Button
                    type="submit"
                    size="lg"
                    className="h-14"
                    disabled={clock.isPending || !employeeNumber || pin.length < 4}
                  >
                    {clock.isPending ? (
                      <Loader2 className="h-5 w-5 animate-spin" />
                    ) : (
                      "Clock"
                    )}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        )}
      </main>

      <PinDeviceDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        current={device}
        onSaved={(d) => {
          if (d) localStorage.setItem(STORAGE_KEY, JSON.stringify(d));
          else localStorage.removeItem(STORAGE_KEY);
          setDevice(d);
        }}
      />
    </div>
  );
}

function PinDeviceDialog({
  open,
  onOpenChange,
  current,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  current: DevicePin | null;
  onSaved: (d: DevicePin | null) => void;
}) {
  const { currentOrg } = useOrganization();
  const { businesses, currentBusiness } = useBusinesses();
  const { branches } = useBranches();

  const [businessId, setBusinessId] = useState<string>(
    current?.businessId ?? currentBusiness?.id ?? "",
  );
  const [branchId, setBranchId] = useState<string>(current?.branchId ?? "");

  const branchesForBusiness = useMemo(
    () => branches.filter((b) => !businessId || (b as any).business_id === businessId),
    [branches, businessId],
  );

  const save = () => {
    if (!currentOrg?.id || !branchId) return;
    const branch = branches.find((b) => b.id === branchId);
    const business = businesses.find((b) => b.id === businessId);
    onSaved({
      orgId: currentOrg.id,
      orgName: currentOrg.name,
      businessId: businessId || null,
      businessName: business?.name ?? null,
      branchId,
      branchName: branch?.name ?? "Branch",
    });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pin device to branch</DialogTitle>
          <DialogDescription>
            The kiosk uses this branch for every clock event, regardless of who is signed in.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Business</Label>
            <Select value={businessId} onValueChange={setBusinessId}>
              <SelectTrigger>
                <SelectValue placeholder="Select business" />
              </SelectTrigger>
              <SelectContent>
                {businesses.map((b) => (
                  <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs">Branch</Label>
            <Select value={branchId} onValueChange={setBranchId}>
              <SelectTrigger>
                <SelectValue placeholder="Select branch" />
              </SelectTrigger>
              <SelectContent>
                {branchesForBusiness.map((b) => (
                  <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter className="flex justify-between sm:justify-between">
          {current && (
            <Button
              variant="ghost"
              onClick={() => {
                onSaved(null);
                onOpenChange(false);
              }}
            >
              Unpin device
            </Button>
          )}
          <div className="flex gap-2 ml-auto">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={save} disabled={!branchId}>Save</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
