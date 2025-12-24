import serverless from "serverless-http";
import { createServer } from "../../server/index";

// We need to initialize the app outside of the handler to reuse it
// if possible, but createServer is async.
let api;

export const handler = async (event, context) => {
  if (!api) {
    const app = await createServer();
    api = serverless(app);
  }
  return api(event, context);
};
