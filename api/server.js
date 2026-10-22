// Local development entry point. On Vercel, api/index.js exports the same app as a serverless function.
import "dotenv/config"; // must stay first: the modules below read process.env when they load
import { getDb, closeDb } from "./_lib/db.js";
import { app } from "./_lib/app.js";
import { log } from "./_lib/logger.js";

const port = Number(process.env.PORT || 4000);
const startedAt = performance.now();
const runtime = typeof Bun !== "undefined" ? "bun" : "node";
const environment = process.env.NODE_ENV || "development";
const mongoUri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";

// Never print credentials embedded in a connection string.
function redact(uri) {
  try {
    const parsed = new URL(uri);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return uri.replace(/\/\/[^@/]+@/, "//***@");
  }
}

getDb()
  .then((db) => log.info("MongoDB connected", { uri: redact(mongoUri), database: db.databaseName }))
  .catch((e) => log.error("MongoDB connection failed", {
    uri: redact(mongoUri),
    error: e,
    hint: "Is MongoDB running? Check MONGODB_URI in api/.env"
  }));

app.listen({ port, hostname: "0.0.0.0" }, () => {
  log.info(`Invento API listening on http://localhost:${port}`, {
    env: environment,
    runtime,
    pid: process.pid,
    startupMs: Math.round(performance.now() - startedAt)
  });
});

// The HTTP adapter installs its own graceful handler, but the MongoDB pool keeps the
// process alive after the server closes. Close both, and force the exit if either hangs.
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    if (shuttingDown) process.exit(0);
    shuttingDown = true;
    log.info("Shutting down", { signal });
    setTimeout(() => process.exit(0), 5000).unref();
    try {
      await app.stop();
      await closeDb();
      log.info("Shutdown complete");
    } catch (e) {
      log.error("Shutdown failed", { error: e });
    }
    process.exit(0);
  });
}
