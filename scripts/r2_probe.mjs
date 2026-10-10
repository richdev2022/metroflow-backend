import { S3Client, PutObjectCommand, ListBucketsCommand, GetBucketLocationCommand } from "@aws-sdk/client-s3";

const accountId = process.env.R2_ACCOUNT_ID || "";
const accessKeyId = process.env.R2_ACCESS_KEY_ID || "";
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY || "";
const bucket = process.env.R2_BUCKET || "";

if (!accountId || !accessKeyId || !secretAccessKey) {
  console.error("Usage: R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... [R2_BUCKET=...] node r2_probe.mjs");
  process.exit(1);
}

const client = new S3Client({
  region: "auto",
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
});

console.log("== ListBuckets ==");
try {
  const lb = await client.send(new ListBucketsCommand({}));
  console.log("OK:", (lb.Buckets || []).map((b) => b.Name).join(", "));
} catch (e) {
  console.log("FAIL:", e.name, "-", e.message);
}

if (bucket) {
  console.log(`== PutObject to ${bucket} ==`);
  try {
    const put = await client.send(new PutObjectCommand({
      Bucket: bucket,
      Key: `_diag/probe-${Date.now()}.txt`,
      Body: Buffer.from("probe"),
      ContentType: "text/plain",
    }));
    console.log("OK: etag", put.ETag);
  } catch (e) {
    console.log("FAIL:", e.name, "-", e.message);
    if (e.Code) console.log("code:", e.Code);
    if (e.ResourceType) console.log("resourceType:", e.ResourceType);
  }
}
