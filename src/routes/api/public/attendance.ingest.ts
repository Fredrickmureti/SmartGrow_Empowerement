/**
 * Attendance hardware ingestion endpoint.
 *
 * External terminals (ZKTeco, Hikvision, Suprema, RFID readers, kiosks) POST
 * here. Authenticates via per-device HMAC-SHA256 signature; bypasses RLS by
 * using `supabaseAdmin` and invoking SECURITY DEFINER RPCs.
 *
 *  Headers:
 *    x-device-id          public_id of the registered device
 *    x-signature          hex HMAC-SHA256(body, device.hmac_secret)
 *    x-timestamp          unix seconds, must be within 300s skew
 *
 *  Body (JSON):
 *    employee_ref   string  (employees.external_attendance_ref)
 *    kind           'in' | 'out' | 'break_start' | 'break_end'
 *    ts             ISO 8601
 *    lat?, lng?     numbers
 *    confidence?    0..1
 *    photo_url?     string (already-uploaded selfie path)
 *
 * Idempotent: replays with the same body hash + device return the previous
 * outcome from attendance_ingest_log.
 */
import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual, createHash } from "node:crypto";

type IngestKind = "in" | "out" | "break_start" | "break_end";
interface Payload {
  employee_ref: string;
  kind: IngestKind;
  ts: string;
  lat?: number;
  lng?: number;
  confidence?: number;
  photo_url?: string;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function verifySig(secret: Buffer, body: string, sig: string): boolean {
  const expected = createHmac("sha256", secret).update(body).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(sig, "hex");
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

export const Route = createFileRoute("/api/public/attendance/ingest")(({
  server: {
    handlers: {
      POST: async ({ request }: { request: Request }) => {
        const deviceId = request.headers.get("x-device-id");
        const sig = request.headers.get("x-signature");
        const tsHeader = request.headers.get("x-timestamp");
        if (!deviceId || !sig || !tsHeader) return json({ error: "missing_headers" }, 400);

        const skew = Math.abs(Date.now() / 1000 - Number(tsHeader));
        if (!Number.isFinite(skew) || skew > 300) return json({ error: "timestamp_skew" }, 401);

        const body = await request.text();
        const payloadHash = createHash("sha256").update(body).digest("hex");

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const { data: device, error: devErr } = await supabaseAdmin
          .from("attendance_devices")
          .select("id, organization_id, business_id, branch_id, hmac_secret, status")
          .eq("public_id", deviceId)
          .maybeSingle();
        if (devErr || !device) return json({ error: "unknown_device" }, 401);
        if (device.status !== "active") return json({ error: "device_not_active" }, 403);

        const secretBuf = Buffer.from((device.hmac_secret as any) as string, "hex");
        // Supabase returns bytea as a hex-encoded string with `\x` prefix; strip it.
        const cleaned = secretBuf.toString("utf8").startsWith("\\x")
          ? Buffer.from(secretBuf.toString("utf8").slice(2), "hex")
          : Buffer.from(device.hmac_secret as any);
        if (!verifySig(cleaned, body, sig)) return json({ error: "bad_signature" }, 401);

        // Idempotency check
        const { data: prior } = await supabaseAdmin
          .from("attendance_ingest_log")
          .select("id, accepted, attendance_id, reason")
          .eq("device_public_id", deviceId)
          .eq("payload_hash", payloadHash)
          .maybeSingle();
        if (prior) {
          return json({
            idempotent: true,
            accepted: prior.accepted,
            attendance_id: prior.attendance_id,
            reason: prior.reason,
          });
        }

        let payload: Payload;
        try {
          payload = JSON.parse(body);
        } catch {
          return json({ error: "invalid_json" }, 400);
        }
        if (!payload.employee_ref || !payload.kind || !payload.ts) {
          return json({ error: "missing_fields" }, 400);
        }

        // Resolve employee by external_attendance_ref within this device's org
        const { data: emp, error: empErr } = await supabaseAdmin
          .from("employees")
          .select("id, organization_id, branch_id")
          .eq("organization_id", device.organization_id)
          .eq("external_attendance_ref", payload.employee_ref)
          .maybeSingle();

        let accepted = false;
        let reason: string | null = null;
        let attendanceId: string | null = null;

        if (empErr || !emp) {
          reason = "employee_not_found";
        } else {
          try {
            if (payload.kind === "in") {
              const { data: id, error } = await supabaseAdmin.rpc("attendance_clock_in", {
                _employee_id: emp.id,
                _branch_id: device.branch_id ?? emp.branch_id,
                _source: "device",
                _location: null,
                _lat: payload.lat ?? null,
                _lng: payload.lng ?? null,
                _accuracy_m: null,
                _device_fp: deviceId,
                _user_agent: "device-ingest",
                _selfie_path: payload.photo_url ?? null,
                _kiosk_pin: null,
              } as any);
              if (error) throw error;
              attendanceId = id as string;
              accepted = true;
            } else if (payload.kind === "out") {
              const { data: id, error } = await supabaseAdmin.rpc("attendance_clock_out", {
                _employee_id: emp.id,
                _location: null,
                _lat: payload.lat ?? null,
                _lng: payload.lng ?? null,
                _accuracy_m: null,
                _device_fp: deviceId,
                _user_agent: "device-ingest",
                _selfie_path: payload.photo_url ?? null,
              } as any);
              if (error) throw error;
              attendanceId = id as string;
              accepted = true;
            } else if (payload.kind === "break_start" || payload.kind === "break_end") {
              // Need an open attendance row first
              const { data: openAtt } = await supabaseAdmin
                .from("attendance")
                .select("id")
                .eq("employee_id", emp.id)
                .is("clock_out", null)
                .maybeSingle();
              if (!openAtt) {
                reason = "no_open_session";
              } else if (payload.kind === "break_start") {
                const { data: id, error } = await supabaseAdmin.rpc("attendance_break_start" as any, {
                  _attendance_id: openAtt.id,
                  _break_type: "rest",
                  _source: "device",
                  _lat: payload.lat ?? null,
                  _lng: payload.lng ?? null,
                  _device_fp: deviceId,
                  _notes: null,
                });
                if (error) throw error;
                attendanceId = openAtt.id;
                accepted = true;
              } else {
                const { data: openBreak } = await supabaseAdmin
                  .from("attendance_breaks")
                  .select("id")
                  .eq("attendance_id", openAtt.id)
                  .is("ended_at", null)
                  .maybeSingle();
                if (!openBreak) {
                  reason = "no_open_break";
                } else {
                  const { error } = await supabaseAdmin.rpc("attendance_break_end" as any, {
                    _break_id: openBreak.id,
                    _lat: payload.lat ?? null,
                    _lng: payload.lng ?? null,
                    _device_fp: deviceId,
                  });
                  if (error) throw error;
                  attendanceId = openAtt.id;
                  accepted = true;
                }
              }
            } else {
              reason = "unknown_kind";
            }
          } catch (e: any) {
            reason = e?.message || "rpc_error";
            accepted = false;
          }
        }

        await supabaseAdmin.from("attendance_ingest_log").insert({
          device_id: device.id,
          device_public_id: deviceId,
          payload_hash: payloadHash,
          employee_ref: payload.employee_ref,
          kind: payload.kind,
          ts: payload.ts,
          accepted,
          reason,
          attendance_id: attendanceId,
        });

        await supabaseAdmin
          .from("attendance_devices")
          .update({ last_seen_at: new Date().toISOString() })
          .eq("id", device.id);

        return json({ accepted, attendance_id: attendanceId, reason }, accepted ? 200 : 422);
      },

      OPTIONS: async () =>
        new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "POST, OPTIONS",
            "access-control-allow-headers": "content-type, x-device-id, x-signature, x-timestamp",
          },
        }),
    },
  },
} as any));
