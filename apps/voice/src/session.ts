import { voice, inference } from "@livekit/agents";
import { ParticipantKind, Room, RoomEvent } from "@livekit/rtc-node";
import * as openai from "@livekit/agents-plugin-openai";
import type { VoiceJob } from "@rigel/server/src/voiceDispatch";
import { buildAgent, refreshInstructions } from "./agent.js";
import { VOICE_SAMPLE_RATE, voiceOutputOptions } from "./audio.js";
import { attachSessionDiagnostics } from "./diagnostics.js";
import { announceAgentState, superviseSession } from "./lifecycle.js";
import type { ServerClient } from "./serverClient.js";
import { applyDataFrame, emptySessionState } from "./state.js";

/**
 * Node terminates a utility process on an unhandled rejection, so every
 * fire-and-forget promise in the room handlers below needs a catch: a single
 * transient failure would otherwise take the whole worker down, and voice with
 * it.
 */
export function logRejection(what: string): (err: unknown) => void {
  return (err) => console.error(`${what} failed:`, err);
}

const sessions = new Map<string, () => Promise<void>>();

export async function runSession(job: VoiceJob, server: ServerClient): Promise<void> {
  const cfg = job.config;
  const room = new Room();
  try {
    await room.connect(cfg.url, cfg.token, { autoSubscribe: true, dynacast: true });
  } catch (err) {
    console.error(`${job.room}: connecting failed:`, err);
    await room.disconnect().catch(logRejection(`${job.room}: leaving the room`));
    return;
  }
  // Diagnostic. kind must read AGENT for the renderer's useVoiceAssistant to
  // find this participant at all, and it is set by the `kind` claim on the
  // token minted in apps/server/src/voiceRoutes.ts, not by the `agent` grant.
  const local = room.localParticipant;
  console.log(
    `${job.room}: connected as ${local?.identity} kind=${local ? (ParticipantKind[local.kind] ?? local.kind) : "?"} for ${job.clientIdentity}`,
  );

  const state = emptySessionState(job.context);
  const agent = buildAgent(state, server, room, job);

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
      sampleRate: VOICE_SAMPLE_RATE,
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
      // Deterministic VAD, not the adaptive detector, which classifies a short
      // utterance near the agent's speech as a backchannel and discards it.
      // "stop" and "no" over a long answer are exactly that shape, and being
      // unable to cut the agent off is the worse failure.
      //
      // resumeFalseInterruption is the SDK's default and it is wrong here: an
      // interruption with no user transcript within two seconds is treated as
      // false, and the answer the operator just stopped starts playing again.
      // In the field that read as the interruption not working, and closing the
      // popover and reopening it found the agent still finishing a reply that
      // had been cut off. An operator who interrupts meant it, and asking again
      // is cheaper than being talked over.
      //
      // minDuration is halved from 500ms for the same reason: the cost of a
      // cough stopping the agent is one repeated question, and the cost of
      // missing a real interruption is talking over the person.
      interruption: { mode: "vad", resumeFalseInterruption: false, minDuration: 250 },
      // A streaming turn detector silently opts the session into
      // streamingEndpointingOptions, whose minDelay is 300ms. Half a second of
      // thought mid-sentence read as the end of the turn, and the agent
      // answered a question the operator had not finished asking. These are the
      // deliberate values: dynamic, so a speaker who pauses is learned rather
      // than talked over, with a floor well clear of an ordinary breath and a
      // ceiling that still ends a turn the detector never calls. Preemptive
      // generation absorbs most of what the floor costs time to first token.
      endpointing: { mode: "dynamic", minDelay: 900, maxDelay: 4000 },
    },
    // The SDK default is 3, which is not a budget for work: a model that makes
    // one recoverable mistake, or that reads three resources before acting, has
    // nothing left and the turn ends in narration. Field-tested at 3 and it
    // ended in narration every time. Each step is one tool call, and the tools
    // are policy-gated, so the ceiling is about patience rather than safety.
    maxToolSteps: 8,
    keytermsOptions: { keyterms: state.keyterms },
  });

  attachSessionDiagnostics(session);

  console.log(`${job.room}: models llm=${cfg.model} stt=${cfg.sttModel} tts=${cfg.ttsModel}`);

  const decoder = new TextDecoder();
  room.on(RoomEvent.DataReceived, (payload: Uint8Array, participant, _kind, topic?: string) => {
    const effect = applyDataFrame(state, job, participant?.identity, topic, decoder.decode(payload));
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
    if (participant?.identity === job.clientIdentity && topic === "rigel.state") {
      void announceAgentState(room, job, session.agentState);
    }
  });

  session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
    console.log(`${job.room}: agent state ${ev.oldState} -> ${ev.newState}`);
    void announceAgentState(room, job, ev.newState);
  });

  room.on(RoomEvent.ParticipantConnected, (participant) => {
    if (participant.identity !== job.clientIdentity) return;
    console.log(`${job.room}: ${job.clientIdentity} joined`);
    void announceAgentState(room, job, session.agentState);
  });

  // Diagnostic. Confirms whether the SDK's own lk.agent.state write lands:
  // rtc-node's setAttributes resolves whether or not the server accepted it,
  // so a missing canUpdateOwnMetadata grant is invisible at the call site.
  room.on(RoomEvent.ParticipantAttributesChanged, (changed, participant) => {
    console.log(`${job.room}: attributes changed for ${participant.identity}:`, changed);
  });

  try {
    await session.start({
      agent,
      room,
      // closeOnDisconnect is off because superviseSession owns the close: the
      // SDK closing the session on its own when the client leaves would race
      // the teardown's close of the same session, and the room has to be left
      // either way.
      //
      // participantIdentity pins the linked participant to the job's client.
      // Anyone else in the room would otherwise be eligible, and the client is
      // the only participant whose audio this agent is allowed to act on.
      inputOptions: { closeOnDisconnect: false, participantIdentity: job.clientIdentity },
      outputOptions: voiceOutputOptions(),
    });
  } catch (err) {
    console.error(`${job.room}: starting the session failed:`, err);
    await session.close().catch(logRejection(`${job.room}: closing the session`));
    await room.disconnect().catch(logRejection(`${job.room}: leaving the room`));
    return;
  }
  superviseSession(sessions, job, room, session);
  console.log(`${job.room}: session started`);
  void announceAgentState(room, job, session.agentState);
}
