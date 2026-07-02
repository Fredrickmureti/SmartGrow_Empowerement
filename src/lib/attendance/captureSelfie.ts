/**
 * Selfie capture for attendance anti-buddy-punch.
 *
 * Opens the user's front camera, snapshots a JPEG, uploads it to the private
 * `attendance-selfies` bucket under `{org_id}/{employee_id}/{yyyy}/{mm}/{uuid}.jpg`
 * and returns the storage path. The RPC stores only the path, never the binary.
 */
import { supabase } from "@/integrations/supabase/client";

export interface CapturedSelfie {
  path: string;
}

export async function captureAndUploadSelfie(opts: {
  orgId: string;
  employeeId: string;
}): Promise<CapturedSelfie> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: 640, height: 480 },
    audio: false,
  });
  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    // Give the sensor a frame or two to settle
    await new Promise((r) => setTimeout(r, 250));

    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas not available");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const blob: Blob = await new Promise((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Snapshot failed"))), "image/jpeg", 0.82)
    );

    const now = new Date();
    const yyyy = now.getUTCFullYear();
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    const uuid = crypto.randomUUID();
    const path = `${opts.orgId}/${opts.employeeId}/${yyyy}/${mm}/${uuid}.jpg`;

    const { error } = await supabase.storage
      .from("attendance-selfies")
      .upload(path, blob, { contentType: "image/jpeg", upsert: false });
    if (error) throw error;

    return { path };
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}
