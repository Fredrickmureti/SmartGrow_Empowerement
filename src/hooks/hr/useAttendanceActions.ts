/**
 * useAttendanceActions — portal-safe attendance mutations.
 *
 * RPC-only. No list read, no `currentBusiness` requirement, no embedded
 * `employees` join. Captures device fingerprint, geolocation, optional selfie,
 * and user agent on every clock attempt for forensic / anti-buddy-punch audit.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useBranches } from "@/hooks/useBranches";
import { useAuth } from "@/contexts/AuthContext";
import { toast } from "sonner";
import { getDeviceFingerprint, getCurrentPosition } from "@/lib/attendance/deviceFingerprint";
import { captureAndUploadSelfie } from "@/lib/attendance/captureSelfie";


function mapRpcError(err: any): Error {
  const msg = err?.message || "Operation failed";
  if (msg.includes("ALREADY_CLOCKED_IN") || msg.includes("open attendance session") || msg.includes("already")) {
    return new Error("You already have an active session. Please clock out first.");
  }
  if (msg.includes("ON_APPROVED_LEAVE") || msg.includes("on approved leave")) {
    return new Error("Cannot clock in on an approved leave day.");
  }
  if (msg.includes("OUTSIDE_GEOFENCE")) return new Error("You are outside the allowed work location.");
  if (msg.includes("GEO_REQUIRED")) return new Error("Location is required. Please allow location access and try again.");
  if (msg.includes("NO_GEOFENCE_DEFINED")) return new Error("No work location is configured for geofencing. Contact HR.");
  if (msg.includes("SELFIE_REQUIRED")) return new Error("A selfie is required. Please allow camera access.");
  if (msg.includes("UNTRUSTED_DEVICE")) return new Error("This device is not yet trusted. HR must approve it before you can clock in.");
  if (msg.includes("DEVICE_REVOKED")) return new Error("This device's trust has been revoked. Contact HR.");
  if (msg.includes("KIOSK_PIN_INVALID")) return new Error("Incorrect kiosk PIN.");
  if (msg.includes("OUTSIDE_SHIFT_WINDOW")) return new Error("You are outside your assigned shift window.");
  if (msg.includes("IMPOSSIBLE_TRAVEL")) return new Error("Suspicious location change detected. Please contact HR.");
  if (msg.includes("DUPLICATE_RECENT_ATTEMPT")) return new Error("Please wait a moment before trying again.");
  if (msg.includes("BREAK_ALREADY_OPEN")) return new Error("You already have an open break. End it first.");
  if (msg.includes("SESSION_CLOSED")) return new Error("This attendance session is already closed.");
  if (msg.includes("locked")) return new Error("This record is locked by payroll and cannot be edited.");
  if (msg.includes("PERMISSION_DENIED") || msg.includes("permission")) return new Error("You don't have permission for this action.");
  return new Error(msg);
}

interface ClockOpts {
  withSelfie?: boolean;
  orgId?: string;
  kioskPin?: string;
}

export function useAttendanceActions() {
  const { currentBranch } = useBranches();
  const { user } = useAuth();
  const qc = useQueryClient();

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["attendance"] });
    qc.invalidateQueries({ queryKey: ["attendance-status"] });
    qc.invalidateQueries({ queryKey: ["my-attendance"] });
    qc.invalidateQueries({ queryKey: ["attendance-corrections"] });
  };

  async function gatherContext(employeeId: string, opts?: ClockOpts) {
    const [fp, pos] = await Promise.all([getDeviceFingerprint(), getCurrentPosition()]);
    let selfie: string | null = null;
    if (opts?.withSelfie && opts.orgId) {
      try {
        const res = await captureAndUploadSelfie({ orgId: opts.orgId, employeeId });
        selfie = res.path;
      } catch (e: any) {
        throw new Error(e?.message || "Selfie capture failed");
      }
    }
    return {
      _device_fp: fp,
      _user_agent: navigator.userAgent.slice(0, 500),
      _lat: pos?.lat ?? null,
      _lng: pos?.lng ?? null,
      _accuracy_m: pos?.accuracy_m ?? null,
      _selfie_path: selfie,
    };
  }

  const clockIn = useMutation({
    mutationFn: async (args: string | { employeeId: string; opts?: ClockOpts }) => {
      const { employeeId, opts } =
        typeof args === "string" ? { employeeId: args, opts: undefined } : args;
      if (!user) throw new Error("Not authenticated");
      const ctx = await gatherContext(employeeId, opts);
      const { data, error } = await supabase.rpc("attendance_clock_in", {
        _employee_id: employeeId,
        _branch_id: currentBranch?.id ?? null,
        _source: "web",
        _location: null,
        _kiosk_pin: opts?.kioskPin ?? null,
        ...ctx,
      } as any);
      if (error) throw mapRpcError(error);
      return data;
    },
    onSuccess: () => { toast.success("Clocked in successfully"); invalidate(); },
    onError: (e: Error) => { console.error("[attendance] RPC failure:", e); toast.error(e.message); },
  });

  const clockOut = useMutation({
    mutationFn: async (args: string | { employeeId: string; opts?: ClockOpts }) => {
      const { employeeId, opts } =
        typeof args === "string" ? { employeeId: args, opts: undefined } : args;
      const ctx = await gatherContext(employeeId, opts);
      const { data, error } = await supabase.rpc("attendance_clock_out", {
        _employee_id: employeeId,
        _location: null,
        ...ctx,
      } as any);
      if (error) throw mapRpcError(error);
      return data;
    },
    onSuccess: () => { toast.success("Clocked out successfully"); invalidate(); },
    onError: (e: Error) => { console.error("[attendance] RPC failure:", e); toast.error(e.message); },
  });

  const requestCorrection = useMutation({
    mutationFn: async (input: {
      attendance_id?: string | null;
      employee_id: string;
      attendance_date: string;
      proposed_clock_in?: string | null;
      proposed_clock_out?: string | null;
      proposed_status?: string | null;
      reason: string;
    }) => {
      const { data, error } = await supabase.rpc("attendance_request_correction", {
        _attendance_id: input.attendance_id ?? null,
        _employee_id: input.employee_id,
        _date: input.attendance_date,
        _proposed_clock_in: input.proposed_clock_in ?? null,
        _proposed_clock_out: input.proposed_clock_out ?? null,
        _proposed_status: input.proposed_status ?? null,
        _reason: input.reason,
      });
      if (error) throw mapRpcError(error);
      return data;
    },
    onSuccess: () => { toast.success("Correction request submitted"); invalidate(); },
    onError: (e: Error) => { console.error("[attendance] RPC failure:", e); toast.error(e.message); },
  });

  const startBreak = useMutation({
    mutationFn: async (input: { attendance_id: string; break_type?: string; notes?: string | null }) => {
      const [fp, pos] = await Promise.all([getDeviceFingerprint(), getCurrentPosition()]);
      const { data, error } = await supabase.rpc("attendance_break_start" as any, {
        _attendance_id: input.attendance_id,
        _break_type: input.break_type ?? "rest",
        _source: "web",
        _lat: pos?.lat ?? null,
        _lng: pos?.lng ?? null,
        _device_fp: fp,
        _notes: input.notes ?? null,
      });
      if (error) throw mapRpcError(error);
      return data;
    },
    onSuccess: () => { toast.success("Break started"); invalidate(); },
    onError: (e: Error) => { console.error("[attendance] RPC failure:", e); toast.error(e.message); },
  });

  const endBreak = useMutation({
    mutationFn: async (break_id: string) => {
      const [fp, pos] = await Promise.all([getDeviceFingerprint(), getCurrentPosition()]);
      const { data, error } = await supabase.rpc("attendance_break_end" as any, {
        _break_id: break_id,
        _lat: pos?.lat ?? null,
        _lng: pos?.lng ?? null,
        _device_fp: fp,
      });
      if (error) throw mapRpcError(error);
      return data;
    },
    onSuccess: () => { toast.success("Break ended"); invalidate(); },
    onError: (e: Error) => { console.error("[attendance] RPC failure:", e); toast.error(e.message); },
  });

  const requestOvertime = useMutation({
    mutationFn: async (input: { employee_id: string; ot_date: string; hours: number; reason?: string }) => {
      const { data, error } = await supabase.rpc("overtime_request_submit" as any, {
        _employee_id: input.employee_id,
        _ot_date: input.ot_date,
        _hours: input.hours,
        _reason: input.reason ?? null,
      });
      if (error) throw mapRpcError(error);
      return data;
    },
    onSuccess: () => { toast.success("Overtime request submitted"); qc.invalidateQueries({ queryKey: ["overtime-requests"] }); },
    onError: (e: Error) => { console.error("[attendance] RPC failure:", e); toast.error(e.message); },
  });

  return {
    clockIn: clockIn.mutate,
    /** Async variant — resolves with the new attendance row UUID so the
        caller can branch on the result (e.g. open LateReasonDialog). */
    clockInAsync: clockIn.mutateAsync,
    clockOut: clockOut.mutate,
    clockOutAsync: clockOut.mutateAsync,
    requestCorrection: requestCorrection.mutate,
    startBreak: startBreak.mutate,
    endBreak: endBreak.mutate,
    requestOvertime: requestOvertime.mutate,
    isClockingIn: clockIn.isPending,
    isClockingOut: clockOut.isPending,
    isStartingBreak: startBreak.isPending,
    isEndingBreak: endBreak.isPending,
  };
}
