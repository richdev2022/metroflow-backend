
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
    if (
      !this.config.accountId ||
      !this.config.accessKeyId ||
      !this.config.secretAccessKey ||
      !this.config.bucketName
    ) {
      logger.warn('Cloudflare R2 credentials not fully configured, R2 storage unavailable');
      return;
    }

    try {
      this.client = new S3Client({
        region: 'auto',
        endpoint: `https://${this.config.accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: this.config.accessKeyId,
          secretAccessKey: this.config.secretAccessKey,
        },
      });
      logger.info('✅ Cloudflare R2 storage initialized');
    } catch (error) {
      logger.error('❌ Failed to initialize Cloudflare R2:', error);
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
      throw new Error('R2 storage is not available');
    }

    const command = new PutObjectCommand({
      Bucket: this.config.bucketName,
      Key: key,
      Body: body,
      ContentType: contentType,
    });

    await this.client.send(command);

    if (this.config.publicUrl) {
      return `${this.config.publicUrl}/${key}`;
    }

    return key;
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
