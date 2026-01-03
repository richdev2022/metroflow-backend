import swaggerJsdoc from "swagger-jsdoc";
// @ts-ignore
import swaggerDocument from "./swagger-output.json";

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
        Business: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            email: { type: "string", format: "email" },
            industry: { type: "string" },
            logoUrl: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        User: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            businessId: { type: "string", format: "uuid" },
            name: { type: "string" },
            email: { type: "string", format: "email" },
            role: { type: "string", enum: ["admin", "manager", "member"] },
            status: { type: "string", enum: ["active", "invited", "inactive"] },
            emailVerified: { type: "boolean" },
            joinedAt: { type: "string", format: "date-time" },
            lastLogin: { type: "string", format: "date-time" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        TeamMember: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            name: { type: "string" },
            email: { type: "string", format: "email" },
            role: { type: "string", enum: ["admin", "manager", "member"] },
            status: { type: "string", enum: ["active", "invited", "inactive"] },
            joinedAt: { type: "string", format: "date-time" },
          },
        },
        Task: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            businessId: { type: "string", format: "uuid" },
            createdBy: { type: "string", format: "uuid" },
            title: { type: "string" },
            description: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            startDate: { type: "string", format: "date" },
            endDate: { type: "string", format: "date" },
            dueDate: { type: "string", format: "date" },
            targetValue: { type: "number" },
            accomplishedValue: { type: "number" },
            epic: { type: "string" },
            epicId: { type: "string", format: "uuid" },
            sprint: { type: "string" },
            isOverdue: { type: "boolean" },
            assignedTo: { 
              type: "array",
              items: { type: "string", format: "uuid" }
            },
            attachments: {
              type: "array",
              items: { $ref: "#/components/schemas/Attachment" }
            },
            comments: {
              type: "array",
              items: { $ref: "#/components/schemas/Comment" }
            },
            images: {
              type: "array",
              items: { type: "string" }
            },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        Epic: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            businessId: { type: "string", format: "uuid" },
            name: { type: "string" },
            description: { type: "string" },
            status: { type: "string", enum: ["active", "completed", "archived"] },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        Idea: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            businessId: { type: "string", format: "uuid" },
            userId: { type: "string", format: "uuid" },
            userName: { type: "string" },
            title: { type: "string" },
            description: { type: "string" },
            status: { type: "string", enum: ["under_review", "executed", "rejected"] },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        Comment: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            taskId: { type: "string", format: "uuid" },
            epicId: { type: "string", format: "uuid" },
            epicName: { type: "string" },
            userId: { type: "string", format: "uuid" },
            userName: { type: "string" },
            userEmail: { type: "string", format: "email" },
            parentCommentId: { type: "string", format: "uuid" },
            content: { type: "string" },
            mentions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["user", "task"] },
                  id: { type: "string" }
                }
              }
            },
            replies: {
              type: "array",
              items: { $ref: "#/components/schemas/Comment" }
            },
            reactions: {
              type: "array",
              items: { $ref: "#/components/schemas/Reaction" }
            },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        Reaction: {
          type: "object",
          properties: {
            userId: { type: "string", format: "uuid" },
            userName: { type: "string" },
            type: { type: "string", enum: ["like", "love", "laugh"] }
          }
        },
        Attachment: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            taskId: { type: "string", format: "uuid" },
            fileName: { type: "string" },
            fileType: { type: "string" },
            fileSize: { type: "number" },
            fileUrl: { type: "string" },
            isImage: { type: "boolean" },
            uploadedBy: { type: "string", format: "uuid" },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        TaskAssignment: {
          type: "object",
          properties: {
            id: { type: "string", format: "uuid" },
            taskId: { type: "string", format: "uuid" },
            userId: { type: "string", format: "uuid" },
            assignedBy: { type: "string", format: "uuid" },
            assignedAt: { type: "string", format: "date-time" },
          },
        },
        KPISummary: {
          type: "object",
          properties: {
            current: {
              type: "object",
              properties: {
                total: { type: "number" },
                completed: { type: "number" },
                percentageCompletion: { type: "number" },
              },
            },
            monthly: {
              type: "object",
              properties: {
                total: { type: "number" },
                completed: { type: "number" },
                percentageCompletion: { type: "number" },
                targetVsAccomplishment: {
                  type: "object",
                  properties: {
                    target: { type: "number" },
                    accomplished: { type: "number" },
                  },
                },
              },
            },
            epics: {
              type: "object",
              additionalProperties: {
                type: "object",
                properties: {
                  total: { type: "number" },
                  completed: { type: "number" },
                  percentageCompletion: { type: "number" },
                  startDate: { type: "string", format: "date" },
                  endDate: { type: "string", format: "date" },
                  assignedTo: { type: "array", items: { type: "string" } },
                },
              },
            },
            overdueTasks: {
              type: "array",
              items: { $ref: "#/components/schemas/Task" },
            },
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
  // In production/bundled env, we don't scan files. We use the imported JSON.
  apis: ["./server/routes/*.ts", "./server/index.ts"],
};

let specs: object = swaggerJsdoc(options);

// Merge with pre-generated docs if available (crucial for production)
if (swaggerDocument) {
  specs = {
    ...specs,
    paths: {
      ...(specs as any).paths,
      ...swaggerDocument.paths
    },
    components: {
      ...(specs as any).components,
      schemas: {
        ...(specs as any).components?.schemas,
        ...swaggerDocument.components?.schemas
      }
    }
  };
}

export { specs };
