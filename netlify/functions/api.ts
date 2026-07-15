import serverless from "serverless-http";
import { createServer } from "../../server/index";
import {
  applyServerlessCorsHeaders,
  getServerlessCorsContext,
  getServerlessCorsResponse,
} from "../../server/serverlessCors";

// We need to initialize the app outside of the handler to reuse it
// if possible, but createServer is async.
let api;

export const handler = async (event, context) => {
  const corsResponse = getServerlessCorsResponse(event);
  if (corsResponse) {
    return corsResponse;
  }

  try {
    if (!api) {
      const app = await createServer();
      api = serverless(app);
    }

    const response = await api(event, context);
    return applyServerlessCorsHeaders(event, response);
  } catch (error) {
    console.error("API handler error:", error);
    const cors = getServerlessCorsContext(event);
    return {
      statusCode: 500,
      headers: cors.headers,
      body: JSON.stringify({
        error: "Internal Server Error",
        message: error instanceof Error ? error.message : "Failed to initialize API",
      }),
    };
  }
};
