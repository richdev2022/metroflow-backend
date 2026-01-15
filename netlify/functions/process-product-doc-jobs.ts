import { processPendingProductDocJobs } from "../../server/services/productDocJobs";

export const handler = async () => {
  const limit = Number(process.env.JOBS_BATCH_LIMIT || "5");
  const result = await processPendingProductDocJobs(limit);
  return {
    statusCode: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ success: true, data: result }),
  };
};
