// Voice worker entry. Fetches its bootstrap from the local server (retrying
// while the server comes up), dials the LiveKit room, and starts the pipeline.
// No LiveKit worker registration/dispatch: this process serves exactly one room.
import { voice, inference } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import { Room, RoomEvent } from "@livekit/rtc-node";
import { buildAgent, refreshInstructions } from "./agent.js";
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
  const agent = buildAgent(state, server, room);

  const session = new voice.AgentSession({
    stt: new inference.STT({
      model: cfg.sttModel,
      apiKey: cfg.apiKey,
      apiSecret: cfg.apiSecret,
    }),
    llm: new openai.LLM({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: cfg.openrouterApiKey,
      model: cfg.model,
    }),
    tts: new inference.TTS({
      model: cfg.ttsModel,
      apiKey: cfg.apiKey,
      apiSecret: cfg.apiSecret,
    }),
    // No `vad:` on purpose. AgentSession auto-provisions the bundled
    // inference.VAD({ model: "silero" }), which runs in-process via
    // @livekit/local-inference. Passing one here would only duplicate it.
    turnHandling: {
      turnDetection: new inference.TurnDetector({
        version: "v1",
        apiKey: cfg.apiKey,
        apiSecret: cfg.apiSecret,
      }),
      // Deterministic VAD, not the adaptive detector: the adaptive one
      // classifies a short utterance near the agent's speech as a backchannel
      // and discards it, and "confirm" spoken over the readback is exactly that
      // shape. Dropping it would silently break the mutation gate.
      interruption: { mode: "vad" },
    },
    keytermsOptions: { keyterms: state.keyterms },
  });

  const decoder = new TextDecoder();
  room.on(RoomEvent.DataReceived, (payload: Uint8Array, participant, _kind, topic?: string) => {
    const effect = applyDataFrame(state, participant?.identity, topic, decoder.decode(payload));
    if (effect.contextChanged) void refreshInstructions(agent, state);
    if (effect.keytermsChanged) session.updateOptions({ keyterms: state.keyterms });
  });

  await session.start({ agent, room });
  console.log("[voice] session started");
}

main().catch((err) => {
  console.error("[voice] fatal:", err);
  process.exit(1);
});
