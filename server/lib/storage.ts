
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import logger from './logger';

interface StorageConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  publicUrl?: string;
}

class R2Storage {
  private client: S3Client | null = null;
  private config: StorageConfig;

  constructor() {
    this.config = {
      accountId: process.env.CLOUDFLARE_R2_ACCOUNT_ID || '',
      accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY || '',
      bucketName: process.env.CLOUDFLARE_R2_BUCKET_NAME || '',
      publicUrl: process.env.CLOUDFLARE_R2_PUBLIC_URL,
    };

    this.init();
  }

  private init(): void {
    console.log("R2 config values:", {
      accountId: this.config.accountId ? "(set)" : "(missing)",
      accessKeyId: this.config.accessKeyId ? "(set)" : "(missing)",
      secretAccessKey: this.config.secretAccessKey ? "(set)" : "(missing)",
      bucketName: this.config.bucketName ? "(set)" : "(missing)",
    });

    if (
      !this.config.accountId ||
      !this.config.accessKeyId ||
      !this.config.secretAccessKey ||
      !this.config.bucketName
    ) {
      logger.warn("Cloudflare R2 credentials not fully configured, R2 storage unavailable");
      return;
    }

    try {
      this.client = new S3Client({
        region: "auto",
        endpoint: `https://${this.config.accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: this.config.accessKeyId,
          secretAccessKey: this.config.secretAccessKey,
        },
      });
      logger.info("✅ Cloudflare R2 storage initialized");
    } catch (error) {
      logger.error("❌ Failed to initialize Cloudflare R2:", error);
    }
  }

  isAvailable(): boolean {
    return this.client !== null;
  }

  async uploadFile(
    key: string,
    body: Buffer | string,
    contentType?: string,
  ): Promise<string> {
    if (!this.client) {
      throw new Error("R2 storage is not available");
    }

    console.log("Uploading to R2:", {
      bucket: this.config.bucketName,
      key,
      accountId: this.config.accountId,
      accessKeyId: this.config.accessKeyId ? "(set)" : "(not set)",
      secretAccessKey: this.config.secretAccessKey ? "(set)" : "(not set)",
      publicUrl: this.config.publicUrl
    });

    try {
      const command = new PutObjectCommand({
        Bucket: this.config.bucketName,
        Key: key,
        Body: body,
        ContentType: contentType,
      });

      const response = await this.client.send(command);
      console.log("R2 upload response:", response);

      if (this.config.publicUrl) {
        return `${this.config.publicUrl}/${key}`;
      }

      return key;
    } catch (error) {
      console.error("R2 upload error details:", error);
      throw error;
    }
  }

  async getFile(key: string): Promise<Buffer> {
    if (!this.client) {
      throw new Error('R2 storage is not available');
    }

    const command = new GetObjectCommand({
      Bucket: this.config.bucketName,
      Key: key,
    });

    const response = await this.client.send(command);
    
    if (!response.Body) {
      throw new Error('File not found');
    }

    const chunks: Uint8Array[] = [];
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }

    return Buffer.concat(chunks);
  }

  async deleteFile(key: string): Promise<void> {
    if (!this.client) {
      throw new Error('R2 storage is not available');
    }

    const command = new DeleteObjectCommand({
      Bucket: this.config.bucketName,
      Key: key,
    });

    await this.client.send(command);
  }

  async getPresignedUrl(key: string, expiresIn: number = 3600): Promise<string> {
    if (!this.client) {
      throw new Error('R2 storage is not available');
    }

    const command = new GetObjectCommand({
      Bucket: this.config.bucketName,
      Key: key,
    });

    return await getSignedUrl(this.client, command, { expiresIn });
  }
}

export const r2Storage = new R2Storage();

/**
 * Cloudinary storage — zero-dependency REST uploader.
 *
 * The production environment provides Cloudinary credentials
 * (CLOUDINARY_URL=cloudinary://<api_key>:<api_secret>@<cloud_name> or the
 * discrete CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET
 * vars). Cloudinary is DIFFERENT from Cloudflare R2 — earlier versions of this
 * code only supported R2, so Cloudinary credentials were silently ignored and
 * every upload fell back to local disk. This class makes those credentials
 * actually work.
 *
 * Upload signature: sha1(sorted params joined with & + api_secret) — the
 * documented Cloudinary signing algorithm. Resource type is derived from the
 * mime type: image -> image upload, video/audio -> video upload, everything
 * else (pdf, docx, zip, ...) -> raw upload.
 */
class CloudinaryStorage {
  private cloudName = "";
  private apiKey = "";
  private apiSecret = "";
  private ready = false;

  constructor() {
    const url = process.env.CLOUDINARY_URL;
    if (url && url.startsWith("cloudinary://")) {
      try {
        const parsed = new URL(url);
        // cloudinary://api_key:api_secret@cloud_name
        this.apiKey = decodeURIComponent(parsed.username);
        this.apiSecret = decodeURIComponent(parsed.password);
        this.cloudName = parsed.hostname;
      } catch {
        console.error("Invalid CLOUDINARY_URL format");
      }
    }
    this.cloudName = (process.env.CLOUDINARY_CLOUD_NAME || this.cloudName || "").trim();
    this.apiKey = (process.env.CLOUDINARY_API_KEY || this.apiKey || "").trim();
    this.apiSecret = (process.env.CLOUDINARY_API_SECRET || this.apiSecret || "").trim();

    this.ready = !!(this.cloudName && this.apiKey && this.apiSecret);

    if (this.ready) {
      console.log("✅ Cloudinary storage initialized for cloud:", this.cloudName);
    } else {
      console.log("Cloudinary credentials not fully configured (cloudName/apiKey/apiSecret)");
    }
  }

  isAvailable(): boolean {
    return this.ready;
  }

  private resourceTypeFor(mimeType?: string, filename?: string): "image" | "video" | "raw" {
    const mt = (mimeType || "").toLowerCase();
    if (mt.startsWith("image/")) return "image";
    if (mt.startsWith("video/") || mt.startsWith("audio/")) return "video";
    // Some clients send generic octet-stream — sniff by extension
    const ext = (filename || "").split(".").pop()?.toLowerCase() || "";
    if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "heic", "heif"].includes(ext)) return "image";
    if (["mp4", "webm", "mov", "avi", "mkv", "mp3", "m4a", "aac", "ogg", "opus", "wav", "m3u8", "3gp", "flac"].includes(ext)) return "video";
    return "raw";
  }

  async uploadFile(
    key: string,
    body: Buffer | string,
    contentType?: string,
  ): Promise<string> {
    if (!this.ready) {
      throw new Error("Cloudinary storage is not available");
    }

    // Key layout: "<folder>/<public_id>.<ext>"
    const normalizedKey = key.replace(/^\/+/, "");
    const lastSlash = normalizedKey.lastIndexOf("/");
    const folder = lastSlash > 0 ? normalizedKey.slice(0, lastSlash) : undefined;
    const filename = lastSlash >= 0 ? normalizedKey.slice(lastSlash + 1) : normalizedKey;
    const dotIdx = filename.lastIndexOf(".");
    const publicId = dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
    const resourceType = this.resourceTypeFor(contentType, filename);

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const params: Record<string, string> = { public_id: publicId, timestamp };
    if (folder) params.folder = folder;

    // Signature = sha1("k=v&k=v" + api_secret) over alphabetically sorted params
    const toSign = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join("&");
    const signature = require("crypto")
      .createHash("sha1")
      .update(`${toSign}${this.apiSecret}`)
      .digest("hex");

    const form = new FormData();
    const blob = typeof body === "string"
      ? new Blob([body], { type: contentType || "text/plain" })
      : new Blob([new Uint8Array(body)], { type: contentType || "application/octet-stream" });
    form.append("file", blob, filename);
    form.append("api_key", this.apiKey);
    form.append("timestamp", timestamp);
    form.append("signature", signature);
    form.append("public_id", publicId);
    if (folder) form.append("folder", folder);

    const endpoint = `https://api.cloudinary.com/v1_1/${this.cloudName}/${resourceType}/upload`;
    const response = await fetch(endpoint, { method: "POST", body: form });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      throw new Error(`Cloudinary upload failed (${response.status}): ${errorText}`);
    }

    const result = (await response.json()) as { secure_url?: string; url?: string };
    const uploadedUrl = result.secure_url || result.url;
    if (!uploadedUrl) {
      throw new Error("Cloudinary upload response missing secure_url");
    }
    return uploadedUrl;
  }

  /**
   * Delete by public URL: derive resource_type + public_id from the URL.
   * Best-effort only (callers swallow errors).
   */
  async deleteByUrl(url: string): Promise<void> {
    if (!this.ready) return;
    try {
      const match = url.match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[a-zA-Z0-9]+)?$/);
      if (!match) return;
      const publicIdWithFolder = match[1];
      const resourceType = url.includes("/video/upload/") ? "video" : url.includes("/image/upload/") ? "image" : "raw";
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const signature = require("crypto")
        .createHash("sha1")
        .update(`public_id=${publicIdWithFolder}&timestamp=${timestamp}${this.apiSecret}`)
        .digest("hex");
      await fetch(`https://api.cloudinary.com/v1_1/${this.cloudName}/${resourceType}/destroy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          public_id: publicIdWithFolder,
          api_key: this.apiKey,
          timestamp,
          signature,
        }),
      });
    } catch (error) {
      console.error("Cloudinary delete failed:", error);
    }
  }
}

export const cloudinaryStorage = new CloudinaryStorage();

/**
 * Preferred cloud object storage for user uploads.
 * Order: Cloudflare R2 (if fully configured) -> Cloudinary -> null (caller
 * falls back to local /uploads disk). Both return directly-usable public URLs.
 */
export function getCloudStorage(): { uploadFile(key: string, body: Buffer | string, contentType?: string): Promise<string> } | null {
  if (r2Storage.isAvailable()) return r2Storage;
  if (cloudinaryStorage.isAvailable()) return cloudinaryStorage;
  return null;
}

/**
 * Normalize a recording storage reference into a directly playable URL.
 *
 * Recording rows can hold three shapes of storage_url:
 *  - an absolute http(s)/data URL (R2 public URL, base64 fallback) → pass through
 *  - a root-served local path "/uploads/<file>" (client-mode uploads on the
 *    droplet disk — served by express.static at the ROOT, not under /api)
 *  - a bare R2 object key "recordings/<businessId>/<id>.mp4" (written by the
 *    LiveKit egress webhook) → presign when possible, otherwise fall back to
 *    the public /files/<key> streaming route.
 *
 * Every endpoint that returns a recording (list, detail, call detail, meeting
 * report) MUST run its storage_url through this helper before responding —
 * a bare key is not a playable URL.
 */
export async function resolveRecordingMediaUrl(storageUrl?: string | null): Promise<string> {
  const raw = String(storageUrl || "").trim();
  if (!raw) return raw;
  if (/^(https?:|data:|blob:)/i.test(raw)) return raw;
  if (raw.startsWith("/uploads/")) return raw;
  if (raw.startsWith("/files/")) return raw;

  const key = raw.replace(/^\/+/, "");
  if (r2Storage.isAvailable()) {
    try {
      return await r2Storage.getPresignedUrl(key, 86400); // 24 hours
    } catch (err) {
      console.error("Failed to presign recording key, falling back to /files route:", key, err);
    }
  }
  return `/files/${key}`;
}

/**
 * Resilient upload used by user-facing flows (KYC documents, avatars, logos):
 * try R2 first; if R2 fails for ANY reason (Access Denied from a revoked
 * token, network blip, bucket misconfig) fall back to an inline data URI for
 * small files so the user's submission still LANDS instead of a raw 500.
 * Files above the data-URI budget rethrow a structured error the route can
 * map to a 503 with an actionable message.
 */
export const DATA_URI_MAX_BYTES = 4 * 1024 * 1024; // 4MB

export async function uploadWithFallback(
  key: string,
  body: Buffer,
  contentType?: string,
): Promise<string> {
  if (r2Storage.isAvailable()) {
    try {
      return await r2Storage.uploadFile(key, body, contentType);
    } catch (err: any) {
      console.error(
        `[storage] R2 upload failed for ${key} [${err?.name || "Error"}: ${err?.message}] — falling back to data URI if small enough`,
      );
    }
  }
  if (Buffer.byteLength(body) <= DATA_URI_MAX_BYTES) {
    return `data:${contentType || "application/octet-stream"};base64,${body.toString("base64")}`;
  }
  const err: any = new Error("Document storage is temporarily unavailable — try smaller files or retry shortly");
  err.code = "STORAGE_UNAVAILABLE";
  throw err;
}
