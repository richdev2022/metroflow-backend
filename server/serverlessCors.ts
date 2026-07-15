import { getCorsHeaders, isCorsOriginAllowed } from "./cors";

type HeaderMap = Record<string, string | undefined>;

type ServerlessLikeEvent = {
  headers?: HeaderMap;
  httpMethod?: string;
  method?: string;
};

type ServerlessLikeResponse = {
  statusCode?: number;
  headers?: Record<string, string | number | boolean>;
  body?: string;
};

export function getServerlessCorsContext(event: ServerlessLikeEvent) {
  const origin = event.headers?.origin || event.headers?.Origin;
  const requestedHeaders =
    event.headers?.["access-control-request-headers"] ||
    event.headers?.["Access-Control-Request-Headers"];

  return {
    origin,
    headers: getCorsHeaders(origin, requestedHeaders),
    method: event.httpMethod || event.method,
  };
}

export function getServerlessCorsResponse(event: ServerlessLikeEvent) {
  const cors = getServerlessCorsContext(event);

  if (cors.origin && !isCorsOriginAllowed(cors.origin)) {
    return {
      statusCode: 403,
      headers: cors.headers,
      body: JSON.stringify({ error: "CORS origin denied" }),
    };
  }

  if (cors.method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: cors.headers,
      body: "",
    };
  }

  return null;
}

export function applyServerlessCorsHeaders(
  event: ServerlessLikeEvent,
  response: ServerlessLikeResponse,
) {
  const cors = getServerlessCorsContext(event);

  return {
    ...response,
    headers: {
      ...response.headers,
      ...cors.headers,
    },
  };
}
