import serverless from 'serverless-http';
import { createServer } from '../../server/index';

let app: any;

export const handler = async (event: any, context: any) => {
  if (!app) {
    app = await createServer();
  }
  const serverlessHandler = serverless(app, {
    request: (req: any, event: any, context: any) => {
      req.netlifyEvent = event;
      req.netlifyContext = context;
    }
  });
  return serverlessHandler(event, context);
};