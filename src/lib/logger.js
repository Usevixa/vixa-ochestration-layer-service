import winston from "winston";

/**
 * Application logger.
 *
 * Console is the only transport that runs by default.
 *
 * ── Seq is mothballed, not deleted ──────────────────────────────────
 * The Seq transport is kept behind an explicit opt-in so it can be brought
 * back whenever the log server actually exists. It is OFF unless BOTH are set:
 *
 *     SEQ_ENABLED=true
 *     SEQ_SERVER_URL=http://<reachable-host>:5341
 *     SEQ_API_KEY=<optional>
 *
 * Note that SEQ_ENABLED is required even though SEQ_SERVER_URL is already
 * present in .env — that URL points at an unreachable VPC address, and
 * requiring a second, deliberate flag stops it waking up by accident.
 *
 * Why it was mothballed: the previous version hard-coded
 * `http://10.106.0.3:5341` as a fallback and attached the transport
 * unconditionally. That host is unroutable from the container, so every log
 * line produced an ENETUNREACH stack trace. The resulting firehose buried the
 * application's own diagnostics in `docker logs`.
 *
 * The dependency stays in package.json and the wiring stays below, so
 * re-enabling is a config change, not a code change.
 */

const transports = [new winston.transports.Console()];

if (process.env.SEQ_ENABLED === "true" && process.env.SEQ_SERVER_URL) {
  try {
    // Imported lazily so a missing or broken package cannot stop the server
    // from booting while the transport is switched off.
    const { SeqTransport } = await import("@datalust/winston-seq");

    transports.push(
      new SeqTransport({
        serverUrl: process.env.SEQ_SERVER_URL,
        apiKey: process.env.SEQ_API_KEY,
        onError: (e) => {
          // Never throw from a log sink.
          console.error("Seq logging error:", e?.message || e);
        },
      }),
    );

    console.log("Seq logging enabled →", process.env.SEQ_SERVER_URL);
  } catch (err) {
    console.error(
      "Seq logging requested but could not be initialised:",
      err?.message || err,
    );
  }
} else {
  console.log("Seq logging disabled (set SEQ_ENABLED=true to turn it on)");
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.errors({ stack: true }),
    winston.format.timestamp(),
    winston.format.json(),
  ),
  // every event automatically carries this, so Seq groups the service
  defaultMeta: { Application: "vixa-orchestration" },
  transports,

  // A logging failure must never take the process down. Winston defaults this
  // to true: combined with handleExceptions on an unreachable transport, an
  // uncaught error would be logged (badly) and then exit the process — which,
  // under `restart: always`, becomes a restart loop that also wipes every
  // in-memory session and strands users mid-transaction.
  exitOnError: false,
});

// Surface crashes in the container log instead of letting them vanish.
logger.exceptions.handle(new winston.transports.Console());
logger.rejections.handle(new winston.transports.Console());

export default logger;
