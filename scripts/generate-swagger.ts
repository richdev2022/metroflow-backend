import fs from "fs";
import path from "path";
import swaggerJsdoc from "swagger-jsdoc";

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "Metricorex API",
      version: "2.0.0",
      description:
        "Metricorex (Metroflow) backend — business work OS with fintech rails. " +
        "Revenue features: Payment Links, Smart Invoices, MetricAi Credit Packs, " +
        "Storefront (hosted product checkout) and Recurring Billing (customer " +
        "subscriptions) — all plan-configurable via /admin/pricing. Auth: JWT bearer tokens.",
    },
    servers: [
      {
        url: "http://localhost:3000",
        description: "Local Development Server",
      },
      {
        url: "/",
        description: "Relative path (Production)",
      }
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
    },
    security: [
      {
        bearerAuth: [],
      },
    ],
  },
  apis: ["./server/routes/*.ts", "./server/index.ts"],
};

const specs = swaggerJsdoc(options);

// Prepend "/api" to all paths
if (specs.paths) {
  const newPaths: any = {};
  for (const [path, methods] of Object.entries(specs.paths)) {
    const newPath = path.startsWith("/api") ? path : `/api${path}`;
    newPaths[newPath] = methods;
  }
  specs.paths = newPaths;
}

const outputPath = path.resolve(process.cwd(), "server/swagger-output.json");

fs.writeFileSync(outputPath, JSON.stringify(specs, null, 2));

console.log(`Swagger spec generated at ${outputPath}`);
