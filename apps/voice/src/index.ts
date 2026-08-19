// Voice worker entry. Fetches its bootstrap from the local server (retrying
// while the server comes up), dials the LiveKit room, and starts the pipeline.
// No LiveKit worker registration/dispatch: this process serves exactly one room.
//
// Log lines carry no prefix of their own. Electron's main process prefixes this
// child's whole stdout/stderr stream with "[voice] " (see forkVoiceWorker in
// apps/desktop/src/main.ts), which also covers the agents SDK's own pino output.
import { voice, inference, initializeLogger } from "@livekit/agents";
import { ParticipantKind, Room, RoomEvent } from "@livekit/rtc-node";
import * as openai from "@livekit/agents-plugin-openai";
import { buildAgent, refreshInstructions } from "./agent.js";
import { announceAgentState, endDesktopSession } from "./lifecycle.js";
import { createServerClient, VoiceNotConfiguredError, type AgentConfig, type ServerClient } from "./serverClient.js";
import { applyDataFrame, DESKTOP_IDENTITY, emptySessionState } from "./state.js";

/**
 * Node terminates a utility process on an unhandled rejection, so every
 * fire-and-forget promise in the room handlers below needs a catch: a single
 * transient failure would otherwise take the whole worker down, and voice with
 * it.
 */
function logRejection(what: string): (err: unknown) => void {
  return (err) => console.error(`${what} failed:`, err);
}

async function bootstrap(server: ServerClient): Promise<AgentConfig> {
  for (let i = 0; i < 30; i++) {
    try {
      return await server.agentConfig();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`agent-config attempt ${i + 1}/30 failed: ${message}`);
      if (i === 29) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error("unreachable");
}

/**
 * sysexits.h EX_CONFIG: "something was found in an unconfigured or
 * misconfigured state". forkVoiceWorker's exit handler in
 * apps/desktop/src/main.ts checks for this exact code (no shared package
 * between these two processes to hold the constant) to retry a missing
 * config patiently instead of feeding it to the crash-loop guard: unlike an
 * actual crash, respawning faster cannot fix "not configured", only the user
 * finishing Settings can.
 */
const NOT_CONFIGURED_EXIT_CODE = 78;

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
  const cfg = await bootstrap(server);

  const room = new Room();
  await room.connect(cfg.url, cfg.token, { autoSubscribe: true, dynacast: true });
  // Diagnostic. kind must read AGENT for the renderer's useVoiceAssistant to
  // find this participant at all, and it is set by the `kind` claim on the
  // token minted in apps/server/src/voiceRoutes.ts, not by the `agent` grant.
  const local = room.localParticipant;
  console.log(
    `connected to room as ${local?.identity} kind=${local ? (ParticipantKind[local.kind] ?? local.kind) : "?"}`,
  );

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
    if (effect.contextChanged) void refreshInstructions(agent, state).catch(logRejection("refreshing instructions"));
    if (effect.keytermsChanged) session.updateOptions({ keyterms: state.keyterms });
    // The desktop ran (or refused) a click-tier change. say() defaults to
    // addToChatCtx, so the agent both tells the operator and stops treating
    // the proposal as outstanding.
    if (effect.speak) session.say(effect.speak);
    // A rigel.state frame is the first thing the renderer publishes once its
    // own handlers are mounted, and the only proof this side gets of that.
    // ParticipantConnected fires earlier, so the announce there can land in a
    // renderer that is not listening yet and simply be dropped.
    if (participant?.identity === DESKTOP_IDENTITY && topic === "rigel.state") {
      void announceAgentState(room, session.agentState);
    }
  });

  session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
    console.log(`agent state ${ev.oldState} -> ${ev.newState}`);
    void announceAgentState(room, ev.newState);
  });

  room.on(RoomEvent.ParticipantConnected, (participant) => {
    if (participant.identity !== DESKTOP_IDENTITY) return;
    console.log("desktop joined");
    void announceAgentState(room, session.agentState);
  });

  room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    if (participant.identity !== DESKTOP_IDENTITY) return;
    console.log("desktop left, scrubbing the session");
    void endDesktopSession(state, agent)
      .then(() => refreshInstructions(agent, state))
      .catch(logRejection("scrubbing the session"));
  });

  // Diagnostic. Confirms whether the SDK's own lk.agent.state write lands:
  // rtc-node's setAttributes resolves whether or not the server accepted it,
  // so a missing canUpdateOwnMetadata grant is invisible at the call site.
  room.on(RoomEvent.ParticipantAttributesChanged, (changed, participant) => {
    console.log(`attributes changed for ${participant.identity}:`, changed);
  });

  await session.start({
    agent,
    room,
    // Without these the desktop closing the popover kills the AgentSession for
    // the life of the worker process: RoomIO closes it on a CLIENT_INITIATED
    // disconnect and nothing ever starts another, so every later connection
    // joins a room holding an agent that will never transcribe again. Keeping
    // the session and relinking on rejoin is what the option is for, and it
    // also skips a pipeline cold start on every reconnect. What a session must
    // NOT keep is handled explicitly in endDesktopSession.
    //
    // participantIdentity pins the linked participant to the desktop. A phone
    // in the room would otherwise be eligible, and the desktop is the only
    // participant whose audio this agent is allowed to act on.
    inputOptions: { closeOnDisconnect: false, participantIdentity: DESKTOP_IDENTITY },
  });
  console.log("session started");
  void announceAgentState(room, session.agentState);
}

main().catch((err) => {
  if (err instanceof VoiceNotConfiguredError) {
    console.error(err.message);
    process.exit(NOT_CONFIGURED_EXIT_CODE);
    return;
  }
  console.error("fatal:", err);
  process.exit(1);
});
