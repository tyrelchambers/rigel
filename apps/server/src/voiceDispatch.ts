import type { AgentConfigResponse, VoiceRole } from "./voiceRoutes";

export interface VoiceJob {
  room: string;
  role: VoiceRole;
  clientIdentity: string;
  context: string | null;
  config: AgentConfigResponse;
}

export type VoiceJobListener = (job: VoiceJob) => void;

export interface VoiceDispatch {
  subscribe(listener: VoiceJobListener): () => void;
  dispatch(job: VoiceJob): boolean;
}

export function createVoiceDispatch(): VoiceDispatch {
  let current: VoiceJobListener | null = null;
  return {
    subscribe(listener) {
      current = listener;
      return () => {
        if (current === listener) current = null;
      };
    },
    dispatch(job) {
      const listener = current;
      if (!listener) return false;
      try {
        listener(job);
        return true;
      } catch {
        if (current === listener) current = null;
        return false;
      }
    },
  };
}

const encoder = new TextEncoder();

export function voiceDispatchStream(hub: VoiceDispatch, heartbeatMs = 15_000): ReadableStream<Uint8Array> {
  let detach = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    detach();
    clearInterval(heartbeat);
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => controller.enqueue(encoder.encode(text));
      detach = hub.subscribe((job) => send(`event: job\ndata: ${JSON.stringify(job)}\n\n`));
      heartbeat = setInterval(() => {
        try {
          send(": ping\n\n");
        } catch {
          stop();
        }
      }, heartbeatMs);
    },
    cancel: stop,
  });
}
