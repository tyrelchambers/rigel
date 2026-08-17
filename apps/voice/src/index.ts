// Voice worker entry. Fetches its bootstrap from the local server (retrying
// while the server comes up), dials the LiveKit room, and starts the pipeline.
// No LiveKit worker registration/dispatch: this process serves exactly one room.
import { voice, inference } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import * as cartesia from "@livekit/agents-plugin-cartesia";
import * as silero from "@livekit/agents-plugin-silero";
import { Room, RoomEvent } from "@livekit/rtc-node";
import { voiceSystemPrompt } from "@rigel/server/src/systemPrompt";
import { createServerClient, type AgentConfig, type ServerClient } from "./serverClient.js";
import { applyDataFrame, emptySessionState } from "./state.js";

async function bootstrap(server: ServerClient): Promise<AgentConfig> {
  for (let i = 0; i < 30; i++) {
    try {
      return await server.agentConfig();
    } catch (err) {
      if (i === 29) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error("unreachable");
}

async function main(): Promise<void> {
  const port = process.env.PORT;
  if (!port) throw new Error("PORT is required");
  const server = createServerClient(
    `http://127.0.0.1:${port}`,
    process.env.RIGEL_SESSION_SECRET ?? "",
    process.env.RIGEL_VOICE_WORKER_TOKEN ?? "",
  );
  const cfg = await bootstrap(server);

  const room = new Room();
  await room.connect(cfg.url, cfg.token, { autoSubscribe: true, dynacast: true });
  console.log("[voice] connected to room");

  const state = emptySessionState();
  const decoder = new TextDecoder();
  room.on(RoomEvent.DataReceived, (payload: Uint8Array, participant, _kind, topic?: string) => {
    applyDataFrame(state, participant?.identity, topic, decoder.decode(payload));
  });

  const session = new voice.AgentSession({
    stt: new deepgram.STT({ apiKey: cfg.deepgramApiKey }),
    llm: new openai.LLM({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: cfg.openrouterApiKey,
      model: cfg.model,
    }),
    tts: new cartesia.TTS({ apiKey: cfg.cartesiaApiKey }),
    vad: await silero.VAD.load(),
    turnHandling: {
      turnDetection: new inference.TurnDetector({
        version: "v1",
        apiKey: cfg.apiKey,
        apiSecret: cfg.apiSecret,
      }),
    },
  });
  const agent = new voice.Agent({ instructions: voiceSystemPrompt(null) });
  await session.start({ agent, room });
  console.log("[voice] session started");
}

main().catch((err) => {
  console.error("[voice] fatal:", err);
  process.exit(1);
});
