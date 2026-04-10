import winston from "winston";
import seq from "winston-seq-updated";

const SeqTransport = seq.default || seq;

const logger = winston.createLogger({
  level: "info",
  transports: [
    new winston.transports.Console(),
    new SeqTransport({
      serverUrl: "https://seq.usevixa.com",
      apiKey: "OHHfwZvuzymWm2oh1lYJ"
    })
  ]
});

export default logger;