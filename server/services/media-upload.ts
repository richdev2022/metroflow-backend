import path from "path";
import crypto from "crypto";
import { r2Storage, cloudinaryStorage } from "../lib/storage";

/**
 * Shared media upload pipeline used by chat attachments, avatars and any other
 * user-generated content. Resolution order:
 *
 *   1. Cloudflare R2   (CLOUDFLARE_R2_* env vars)
 *   2. Cloudinary      (CLOUDINARY_URL or CLOUDINARY_CLOUD_NAME/API_KEY/SECRET)
 *   3. Local /uploads  (served statically by the API; absolute URL returned)
 *
 * Both cloud targets return permanent public URLs, so web and mobile can
 * render/play/download attachments directly without extra auth.
 */

export type MediaKind = "image" | "video" | "audio" | "document" | "gif" | "sticker";

const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "heic", "heif"];
const VIDEO_EXTS = ["mp4", "webm", "mov", "avi", "mkv", "3gp", "flv", "m4v", "mpeg", "mpg", "ogv"];
const AUDIO_EXTS = ["mp3", "m4a", "aac", "ogg", "oga", "opus", "wav", "weba", "flac", "wma", "amr"];
// Documents: pdf + office + text + archives + misc
const DOC_EXTS = [
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "rtf", "csv", "tsv",
  "md", "json", "xml", "zip", "rar", "7z", "tar", "gz", "apk", "ics",
];

export function detectMediaKind(mimeType?: string, filename?: string): MediaKind {
  const mt = (mimeType || "").toLowerCase();
  const ext = (filename || "").split(".").pop()?.toLowerCase() || "";
  if (mt.startsWith("image/gif")) return "gif";
  if (mt.startsWith("image/")) return "image";
  if (mt.startsWith("video/")) return "video";
  if (mt.startsWith("audio/")) return "audio";
  if (IMAGE_EXTS.includes(ext)) return ext === "gif" ? "gif" : "image";
  if (VIDEO_EXTS.includes(ext)) return "video";
  if (AUDIO_EXTS.includes(ext)) return "audio";
  if (DOC_EXTS.includes(ext)) return "document";
  return "document";
}

export function safeExtension(originalname: string, mimeType?: string): string {
  const ext = originalname.includes(".")
    ? originalname.split(".").pop()!.toLowerCase().replace(/[^a-z0-9]/g, "")
    : "";
  if (ext && ext.length <= 5) return ext;
  const mt = (mimeType || "").toLowerCase();
  if (mt.includes("png")) return "png";
  if (mt.includes("jpeg") || mt.includes("jpg")) return "jpg";
  if (mt.includes("gif")) return "gif";
  if (mt.includes("webp")) return "webp";
  if (mt.includes("webm")) return "webm";
  if (mt.includes("mp4")) return "mp4";
  if (mt.includes("mpeg") || mt.includes("mp3")) return "mp3";
  if (mt.includes("m4a")) return "m4a";
  if (mt.includes("aac")) return "aac";
  if (mt.includes("ogg")) return "ogg";
  if (mt.includes("opus")) return "opus";
  if (mt.includes("wav")) return "wav";
  if (mt.includes("pdf")) return "pdf";
  if (mt.includes("zip")) return "zip";
  if (mt.includes("csv")) return "csv";
  return "bin";
}

export function resolveAbsoluteUrl(url: string): string {
  if (url && url.startsWith("/")) {
    const apiOrigin = process.env.API_PUBLIC_BASE_URL
      || process.env.APP_BASE_URL
      || "https://api.metricorex.com";
    return `${apiOrigin.replace(/\/$/, "")}${url}`;
  }
  return url;
}

export interface UploadedMedia {
  url: string;
  filename: string;
  size: number;
  mimeType: string;
  kind: MediaKind;
  storage: "r2" | "cloudinary" | "local";
}

/**
 * Upload a buffer through the storage chain. Never throws for cloud failures —
 * gracefully degrades to local disk so chat/media features keep working.
 */
export async function uploadMediaBuffer(opts: {
  buffer: Buffer;
  originalname: string;
  mimeType: string;
  folder: string;              // e.g. "chat-media" | "avatars"
  businessId?: string;
  userId?: string;
  forceLocal?: boolean;
}): Promise<UploadedMedia> {
  const { buffer, originalname, mimeType, folder } = opts;
  const kind = detectMediaKind(mimeType, originalname);
  const ext = safeExtension(originalname, mimeType);
  const stem = `${opts.userId || "anon"}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const key = opts.businessId
    ? `${folder}/${opts.businessId}/${stem}.${ext}`
    : `${folder}/${stem}.${ext}`;

  // 1 & 2 — cloud storage (R2 first, then Cloudinary)
  if (!opts.forceLocal) {
    const cloud = r2Storage.isAvailable()
      ? r2Storage
      : (cloudinaryStorage.isAvailable() ? cloudinaryStorage : null);
    if (cloud) {
      try {
        const rawUrl = await cloud.uploadFile(key, buffer, mimeType);
        // R2 WITHOUT a configured public URL returns the bare object KEY
        // ("metricai/123-abc.png") — clients cannot load a bare key as a
        // URL, which is exactly why MetricAi generated images (and other
        // cloud uploads) rendered as broken images on web and mobile.
        // Normalize to the API's /files/<key> media route; the mobile/web
        // media resolvers already absolutize root-relative paths.
        const url = /^https?:\/\//i.test(rawUrl) || rawUrl.startsWith("/")
          ? rawUrl
          : `/files/${rawUrl}`;
        return {
          url,
          filename: originalname || `${stem}.${ext}`,
          size: buffer.length,
          mimeType,
          kind,
          storage: cloud === cloudinaryStorage ? "cloudinary" : "r2",
        };
      } catch (error) {
        console.error(`Cloud upload failed for ${folder}, falling back to local:`, error);
      }
    }
  }

  // 3 — local /uploads (always exists as a static directory on the API host)
  const fs = await import("fs");
  const isLambda = !!process.env.LAMBDA_TASK_ROOT || !!process.env.NETLIFY;
  const baseDir = isLambda ? "/tmp" : process.cwd();
  const uploadDir = path.join(baseDir, "uploads");
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }
  const filename = `${stem}.${ext}`;
  fs.writeFileSync(path.join(uploadDir, filename), buffer);

  let url = `/uploads/${filename}`;
  if (isLambda) {
    try {
      const { getStore } = require("@netlify/blobs");
      const store = getStore("uploads");
      await store.set(filename, buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ) as any);
    } catch (blobErr) {
      // NEVER fall back to a data: URI — a base64 video inlined into
      // chat_messages.attachment_url makes every message-list response carry
      // megabytes of JSON and video players cannot stream data: URIs. Fail
      // the upload loudly instead so callers return a proper error.
      try { fs.unlinkSync(path.join(uploadDir, filename)); } catch {}
      throw new Error(
        `Media upload failed: serverless blob storage unavailable (${blobErr?.message || blobErr})`,
      );
    }
  }

  return {
    url: resolveAbsoluteUrl(url),
    filename: originalname || filename,
    size: buffer.length,
    mimeType,
    kind,
    storage: "local",
  };
}

/** Best-effort local cleanup for data-URI / temp artefacts. */
export function tryUnlinkLocal(filename: string): void {
  try {
    const fs = require("fs");
    const path = require("path");
    fs.unlinkSync(path.join(process.cwd(), "uploads", filename));
  } catch {}
}
