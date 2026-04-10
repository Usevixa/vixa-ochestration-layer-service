// lib/logger.js (or src/lib/logger.js)
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport:
    process.env.NODE_ENV === 'production'
      ? {
          target: 'pino-seq',
          options: {
            serverUrl: process.env.SEQ_SERVER_URL,
            apiKey: process.env.SEQ_API_KEY,
          },
        }
      : {
          target: 'pino-pretty',
        },
});

export default logger;