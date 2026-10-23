import path from "path";
import os from "os";
import fs from "fs";
import crypto from "crypto";
import { execFile } from "child_process";

/**
 * Server-side video thumbnail extraction (ffmpeg on the API host).
 *
 * The composer already captures a poster frame client-side (canvas snapshot).
 * This service fills the gap for everything that arrives WITHOUT one — old
 * clients, the mobile app, failed captures — so every video post ends up with
 * a real og:image and a feed thumbnail.
 *
 * Design constraints:
 *   - Best-effort ONLY. If ffmpeg is missing (Netlify/serverless images have
 *     no system binaries) or the codec is unsupported, callers get `null` and
 *     degrade to the no-poster path. A thumbnail failure must never fail the
 *     upload or the post.
 *   - Serverless short-circuit: probing/running ffmpeg inside a Netlify/Lambda
 *     function is guaranteed dead weight, so skip it entirely there.
 */

let ffmpegUsable: boolean | null = null;

function isServerless(): boolean {
  return !!process.env.LAMBDA_TASK_ROOT || !!process.env.NETLIFY;
}

/** Probe (once per process) whether ffmpeg exists and runs on this host. */
export async function isFfmpegAvailable(): Promise<boolean> {
  if (isServerless()) return false;
  if (ffmpegUsable !== null) return ffmpegUsable;
  ffmpegUsable = await new Promise<boolean>((resolve) => {
    try {
      execFile("ffmpeg", ["-version"], { timeout: 5000 }, (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });
  return ffmpegUsable;
}

/**
 * Extract a single poster frame from a video buffer.
 *
 * Tries a spread of early offsets (0.8s → 0.2s → 2.5s) because the first
 * attempt can outrun the container header/first keyframe on short clips, and
 * a bare 0s grab frequently lands on a black lead-in frame.
 *
 * @returns a JPEG Buffer, or null when ffmpeg is unavailable / the video
 *          cannot be decoded. Never throws.
 */
export async function extractVideoPosterFrame(
  video: Buffer,
  opts?: { maxWidth?: number },
): Promise<Buffer | null> {
  if (!(await isFfmpegAvailable())) return null;
  if (!video || video.length < 1024) return null;

  const maxWidth = Math.min(Math.max(opts?.maxWidth ?? 720, 160), 1920);
  const tmpDir = os.tmpdir();
  const stem = `vthumb-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const inputPath = path.join(tmpDir, `${stem}.bin`);
  const offsets = [0.8, 0.2, 2.5];

  try {
    await fs.promises.writeFile(inputPath, video);
    for (const offset of offsets) {
      try {
        const stdout = await new Promise<Buffer>((resolve, reject) => {
          execFile(
            "ffmpeg",
            [
              "-hide_banner", "-loglevel", "error",
              "-ss", String(offset),
              "-i", inputPath,
              "-frames:v", "1",
              // Even-dimension scale (x264/x265 forbid odd widths) + solid
              // quality — big enough for og:image, small enough to upload fast.
              "-vf", `scale='min(${maxWidth},iw)':-2`,
              "-q:v", "4",
              "-f", "image2pipe",
              "-vcodec", "mjpeg",
              "pipe:1",
            ],
            { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
            (err, stdoutBuf, stderr) => {
              if (err) reject(new Error(String(stderr || err).slice(0, 200)));
              else resolve(typeof stdoutBuf === "string" ? Buffer.from(stdoutBuf) : Buffer.from(stdoutBuf));
            },
          );
        });
        // A valid JPEG frame is comfortably >1KB; smaller outputs are ffmpeg
        // edge-case artefacts (e.g. header-only writes) — treat as failure.
        if (stdout && stdout.length > 1024) return stdout;
      } catch {
        // offset beyond the clip end / decode hiccup — try the next offset
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    fs.promises.unlink(inputPath).catch(() => {});
  }
}
