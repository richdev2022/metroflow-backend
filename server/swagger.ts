import swaggerJsdoc from "swagger-jsdoc";

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "MetricFlow API",
      version: "1.0.0",
      description: "API documentation for MetricFlow Backend",
    },
    servers: [
      {
        url: "http://localhost:3000/api",
        description: "Local Development Server",
      },
      {
        url: "/api",
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
      schemas: {
        Task: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            title: { type: "string" },
            description: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            startDate: { type: "string", format: "date" },
            endDate: { type: "string", format: "date" },
            targetValue: { type: "number" },
            accomplishedValue: { type: "number" },
            epic: { type: "string" },
            sprint: { type: "string" },
            isOverdue: { type: "boolean" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        User: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            email: { type: "string", format: "email" },
            role: { type: "string", enum: ["admin", "manager", "member"] },
            status: { type: "string", enum: ["active", "invited", "inactive"] },
          },
        },
        Business: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            email: { type: "string", format: "email" },
          },
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

export const specs = swaggerJsdoc(options);
