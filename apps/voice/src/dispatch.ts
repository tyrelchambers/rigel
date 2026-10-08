import type { VoiceJob } from "@rigel/server/src/voiceDispatch";
import type { ServerClient } from "./serverClient.js";

export interface SseEvent {
  event: string;
  data: string;
}

export function createSseParser(): (chunk: string) => SseEvent[] {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    const events: SseEvent[] = [];
    let end = buffer.indexOf("\n\n");
    while (end !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const field = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "event") event = value;
        if (field === "data") data.push(value);
      }
      if (data.length > 0) events.push({ event, data: data.join("\n") });
      end = buffer.indexOf("\n\n");
    }
    return events;
  };
}

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 10_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function listenForJobs(
  server: Pick<ServerClient, "jobs">,
  onJob: (job: VoiceJob) => void,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<never> {
  let backoff = MIN_BACKOFF_MS;
  let lastFailure: string | null = null;
  for (;;) {
    try {
      const jobs = await server.jobs();
      backoff = MIN_BACKOFF_MS;
      lastFailure = null;
      console.log("waiting for voice jobs");
      for await (const job of jobs) onJob(job);
      console.log("dispatch stream ended");
    } catch (err) {
      const failure = err instanceof Error ? err.message : String(err);
      if (failure !== lastFailure) console.error(`dispatch stream failed: ${failure}`);
      lastFailure = failure;
    }
    await wait(backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }
}
