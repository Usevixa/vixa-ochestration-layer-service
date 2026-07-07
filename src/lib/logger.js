import winston from 'winston';
import { SeqTransport } from '@datalust/winston-seq';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.errors({ stack: true }),
    winston.format.timestamp(),
    winston.format.json()
  ),
  // every event automatically carries this, so Seq groups the service
  defaultMeta: { Application: 'vixa-orchestration' },
  transports: [
    new winston.transports.Console(),
    new SeqTransport({
      serverUrl: process.env.SEQ_SERVER_URL || 'http://10.106.0.3:5341',
      apiKey: process.env.SEQ_API_KEY,
      onError: (e) => { console.error('Seq logging error:', e); },
      handleExceptions: true,
      handleRejections: true
    })
  ]
});

export default logger;