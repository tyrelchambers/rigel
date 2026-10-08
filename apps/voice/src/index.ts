// Voice worker entry. Holds the local server's dispatch stream open (retrying
// while the server comes up or restarts) and joins a fresh LiveKit room for
// each job it hands down, one AgentSession per client connection. No LiveKit
// worker registration: the server is what dispatches.
//
// Log lines carry no prefix of their own. Electron's main process prefixes this
// child's whole stdout/stderr stream with "[voice] " (see forkVoiceWorker in
// apps/desktop/src/main.ts), which also covers the agents SDK's own pino output.
import { initializeLogger } from "@livekit/agents";
import { listenForJobs } from "./dispatch.js";
import { createServerClient } from "./serverClient.js";
import { logRejection, runSession } from "./session.js";

async function main(): Promise<void> {
  // Every agents-SDK class logs from a field initializer, so constructing one
  // before this throws "logger not initialized". Must run before the pipeline.
  initializeLogger({ pretty: false, level: "info" });
  const port = process.env.PORT;
  if (!port) throw new Error("PORT is required");
  const server = createServerClient(
    `http://127.0.0.1:${port}`,
    process.env.RIGEL_SESSION_SECRET ?? "",
    process.env.RIGEL_VOICE_WORKER_TOKEN ?? "",
  );
  await listenForJobs(server, (job) => {
    console.log(`job: ${job.role} room ${job.room}`);
    void runSession(job, server).catch(logRejection(`${job.room}: running the session`));
  });
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
