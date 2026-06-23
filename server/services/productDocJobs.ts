import { query } from "../db";
import { generateProductDocumentation, regenerateProductDocumentation } from "./ai";
import { sendEmail } from "./email";

type JobType = "generate" | "regenerate";

export async function processPendingProductDocJobs(limit: number = 5) {
  const pendingJobsResult = await query(
    `
      SELECT *
      FROM product_documentation_jobs
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT $1
    `,
    [limit]
  );

  if (pendingJobsResult.rows.length === 0) {
    return { processed: 0, completed: 0, failed: 0 };
  }

  let processed = 0;
  let completed = 0;
  let failed = 0;

  for (const job of pendingJobsResult.rows) {
    processed++;

    try {
      await query(
        `UPDATE product_documentation_jobs SET status = 'processing', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [job.id]
      );

      const jobType: JobType = job.job_type;

      if (jobType === "generate") {
        await handleGenerateJob(job);
      } else if (jobType === "regenerate") {
        await handleRegenerateJob(job);
      } else {
        throw new Error(`Unknown product documentation job type: ${jobType}`);
      }

      await query(
        `UPDATE product_documentation_jobs SET status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [job.id]
      );

      completed++;
    } catch (error: any) {
      failed++;

      await query(
        `UPDATE product_documentation_jobs 
         SET status = 'failed', error = $2, updated_at = CURRENT_TIMESTAMP 
         WHERE id = $1`,
        [job.id, error?.message || String(error)]
      );
    }
  }

  return { processed, completed, failed };
}

async function handleGenerateJob(job: any) {
  const ideaResult = await query(
    `SELECT title, description FROM ideas WHERE id = $1 AND business_id = $2`,
    [job.idea_id, job.business_id]
  );

  if (ideaResult.rows.length === 0) {
    throw new Error("Idea not found for generate job");
  }

  const { title, description } = ideaResult.rows[0];

  const content = await generateProductDocumentation(title, description);

  const docResult = await query(
    `UPDATE product_documentation
     SET title = $1,
         content = $2,
         status = 'completed',
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $3 AND business_id = $4
     RETURNING *`,
    [title, content, job.doc_id, job.business_id]
  );

  if (docResult.rows.length === 0) {
    throw new Error("Product documentation row not found when completing generate job");
  }

  const doc = docResult.rows[0];

  await sendProductDocReadyEmail(job.business_id, job.user_id, doc.title, "generate");
}

async function handleRegenerateJob(job: any) {
  const docResult = await query(
    `SELECT * FROM product_documentation WHERE id = $1 AND business_id = $2`,
    [job.doc_id, job.business_id]
  );

  if (docResult.rows.length === 0) {
    throw new Error("Product documentation not found for regenerate job");
  }

  const doc = docResult.rows[0];
  const currentContent: string = doc.content;
  const areasOfConcern: string = job.areas_of_concern || "";

  const newContent = await regenerateProductDocumentation(currentContent, areasOfConcern);

  const updatedResult = await query(
    `UPDATE product_documentation
     SET content = $1,
         status = 'completed',
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $2 AND business_id = $3
     RETURNING *`,
    [newContent, job.doc_id, job.business_id]
  );

  if (updatedResult.rows.length === 0) {
    throw new Error("Product documentation row not found when completing regenerate job");
  }

  const updatedDoc = updatedResult.rows[0];

  await sendProductDocReadyEmail(job.business_id, job.user_id, updatedDoc.title, "regenerate");
}

async function sendProductDocReadyEmail(
  businessId: string,
  userId: string,
  docTitle: string,
  jobType: JobType
) {
  const userResult = await query(
    `SELECT name, email FROM users WHERE id = $1 AND business_id = $2`,
    [userId, businessId]
  );

  if (userResult.rows.length === 0) {
    return;
  }

  const user = userResult.rows[0];

  const subject =
    jobType === "generate"
      ? `Your product documentation "${docTitle}" is ready`
      : `Your product documentation "${docTitle}" has been updated`;

  const baseUrl = process.env.APP_BASE_URL || process.env.APP_URL;
  const dashboardUrl = baseUrl ? `${baseUrl}/ideas` : "http://localhost:8080/ideas";
  const logoUrl = baseUrl
    ? `${baseUrl}/Assets/logo.png`
    : "https://cdn.builder.io/api/v1/image/assets%2F46d24169bc6640e4a28cf8a42de16442%2F5d8ef2d7f38346fbb44eb85f01d7d899";

  const actionText =
    jobType === "generate"
      ? "A new product documentation has been generated for your idea."
      : "Your product documentation has been regenerated based on your feedback.";

  const emailHtml = `
    <html>
      <body style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f3f4f6; padding: 40px 0; margin: 0;">
        <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 40px; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);">
          <div style="text-align: center; margin-bottom: 30px;">
            <img src="${logoUrl}" alt="Metrocorex Logo" style="max-width: 180px; height: auto;" />
          </div>

          <h1 style="color: #111827; font-size: 22px; font-weight: 700; text-align: center; margin-bottom: 16px;">
            Product documentation is ready
          </h1>

          <p style="color: #374151; font-size: 15px; line-height: 1.6; margin-bottom: 16px;">
            Hi ${user.name},
          </p>

          <p style="color: #374151; font-size: 15px; line-height: 1.6; margin-bottom: 16px;">
            ${actionText}
          </p>

          <div style="background-color: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-bottom: 24px;">
            <p style="margin: 0; color: #111827; font-size: 16px; font-weight: 600;">
              ${docTitle}
            </p>
          </div>

          <div style="text-align: center; margin: 30px 0;">
            <a href="${dashboardUrl}"
               style="background-color: #2563eb; color: white; padding: 12px 30px; text-decoration: none; border-radius: 8px; display: inline-block; font-weight: 600;">
              View in Metrocorex
            </a>
          </div>

          <p style="color: #6b7280; font-size: 13px; text-align: center; margin-top: 24px;">
            You received this email because you requested product documentation generation in Metrocorex.
          </p>
        </div>
      </body>
    </html>
  `;

  await sendEmail(user.email, user.name, subject, emailHtml);
}

