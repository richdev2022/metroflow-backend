import winston from "winston";

const { combine, timestamp, json, colorize, printf } = winston.format;

const isProduction = process.env.NODE_ENV === "production";

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: combine(
    timestamp(),
    json(),
  ),
  defaultMeta: { service: "metricflow-backend" },
  transports: [
    new winston.transports.Console({
      format: isProduction
        ? combine(timestamp(), json())
        : combine(
            colorize(),
            printf(({ timestamp, level, message, ...meta }) => {
              return `${timestamp} [${level}]: ${message} ${
                Object.keys(meta).length ? JSON.stringify(meta, null, 2) : ""
              }`;
            }),
          ),
    }),
  ],
});

export default logger;
