import { Room, RoomEvent, ConnectionState } from "livekit-client";
import { useEffect, useState, useRef, useCallback } from "react";

export default function VoiceRoom({ token, livekitUrl, onEnd }) {
  const [room, setRoom] = useState(null);
  const [transcript, setTranscript] = useState([]);
  const [ragSources, setRagSources] = useState([]);
  const [isConnected, setIsConnected] = useState(false);
  const [agentState, setAgentState] = useState("initializing");
  const [isMicEnabled, setIsMicEnabled] = useState(false);
  const [connectionError, setConnectionError] = useState(null);

  const roomRef = useRef(null);
  const isConnectingRef = useRef(false);
  const isMountedRef = useRef(true);

  const resumeAudioContext = useCallback(async () => {
    try {
      const ctx = roomRef.current?.audioContext;
      if (ctx && ctx.state === "suspended") {
        await ctx.resume();
        console.log("AudioContext resumed");
      }
      // Also try the global one
      if (window.AudioContext || window.webkitAudioContext) {
        // nothing to do globally – rely on livekit's context
      }
    } catch (e) {
      console.warn("Could not resume AudioContext:", e);
    }
  }, []);

  const reattachAllAudio = useCallback((r) => {
    if (!r) return;
    r.remoteParticipants.forEach((participant) => {
      participant.audioTrackPublications.forEach((pub) => {
        if (pub.track && pub.isSubscribed) {
          attachAudioTrack(pub.track, participant.identity);
        }
      });
    });
  }, []);

  const attachAudioTrack = (track, identity) => {
    const id = `audio-${identity}`;
    const existing = document.getElementById(id);
    if (existing) existing.remove();

    const el = track.attach();
    el.id = id;
    el.autoplay = true;
    el.playsInline = true;
    el.muted = false;
    el.volume = 1.0;
    document.body.appendChild(el);

    el.play().catch((err) => {
      console.warn(`Audio autoplay blocked for ${identity}:`, err);
    });
  };

  useEffect(() => {
    isMountedRef.current = true;
    if (!token || !livekitUrl) return;
    if (isConnectingRef.current) return;
    isConnectingRef.current = true;
    setConnectionError(null);

    const r = new Room({
      adaptiveStream: true,
      dynacast: true,
      disconnectOnPageLeave: false,
    });

    const cleanup = () => {
      isMountedRef.current = false;
      document.querySelectorAll('[id^="audio-"]').forEach((el) => el.remove());
      if (r.state !== ConnectionState.Disconnected) r.disconnect();
    };

    r.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      if (!isMountedRef.current) return;
      const actualTopic = typeof participant === "string" ? participant : topic;
      const text = new TextDecoder().decode(payload);

      if (actualTopic === "transcript") {
        setTranscript((prev) => {
          if (prev.length > 0 && prev[prev.length - 1] === text) return prev;
          const clean = (s) => s.replace(/^(USER|BOT|AGENT):/, "").trim();
          if (prev.some((e) => clean(e) === clean(text))) return prev;
          return [...prev, text];
        });
      } else if (actualTopic === "rag_sources") {
        try {
          const data = JSON.parse(text);
          const sourceFiles = [...new Set(data.sources || [])];
          setRagSources((prev) => {
            const combined = [...prev];
            for (const src of sourceFiles) {
              if (src && !combined.includes(src)) combined.push(src);
            }
            return combined.slice(-8);
          });
        } catch (e) {
          console.error("RAG sources parse error:", e);
        }
      }
    });

    r.on(RoomEvent.Connected, () => {
      if (!isMountedRef.current) return;
      console.log("Room connected");
      setIsConnected(true);
      setAgentState("waiting");
    });

    r.on(RoomEvent.Disconnected, (reason) => {
      if (!isMountedRef.current) return;
      console.log("Room disconnected:", reason);
      setIsConnected(false);
      setIsMicEnabled(false);
    });

    r.on(RoomEvent.Reconnecting, () => {
      if (!isMountedRef.current) return;
      console.log("Reconnecting…");
      setIsConnected(false);
      setAgentState("initializing");
    });

    r.on(RoomEvent.Reconnected, async () => {
      if (!isMountedRef.current) return;
      console.log("Reconnected!");
      setIsConnected(true);
      setAgentState("waiting");

      await resumeAudioContext();
      reattachAllAudio(r);

      try {
        const micPub = r.localParticipant?.getTrackPublication("audio");
        if (micPub && micPub.isMuted === false) {
          await r.localParticipant.setMicrophoneEnabled(true);
          setIsMicEnabled(true);
        }
      } catch (e) {
        console.warn("Could not re-enable mic after reconnect:", e);
      }
    });

    r.on(RoomEvent.ParticipantConnected, (participant) => {
      if (!isMountedRef.current) return;
      console.log("Participant connected:", participant.identity, participant.kind);
      const isAgent = participant.kind === 4 || participant.isAgent;
      if (isAgent) setAgentState("listening");
    });

    r.on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (!isMountedRef.current) return;
      console.log("Participant disconnected:", participant.identity);
      const el = document.getElementById(`audio-${participant.identity}`);
      if (el) el.remove();
    });

    r.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      if (!isMountedRef.current) return;
      if (track.kind !== "audio") return;
      attachAudioTrack(track, participant.identity);
    });

    r.on(RoomEvent.TrackUnsubscribed, (track, _publication, participant) => {
      if (!isMountedRef.current) return;
      track.detach().forEach((el) => el.remove());
      const el = document.getElementById(`audio-${participant.identity}`);
      if (el) el.remove();
    });

    console.log("Connecting to LiveKit…");
    r.connect(livekitUrl, token, { autoSubscribe: true })
      .then(() => {
        if (!isMountedRef.current) { r.disconnect(); return; }
        roomRef.current = r;
        setRoom(r);
        console.log("Room connected successfully");
      })
      .catch((err) => {
        console.error("Failed to connect:", err);
        if (isMountedRef.current) setConnectionError(err.message);
        isConnectingRef.current = false;
      });

    return cleanup;
  }, [token, livekitUrl]);


  const startMic = useCallback(async () => {
    if (!room) return;
    try {
      await resumeAudioContext();

      document.querySelectorAll('[id^="audio-"]').forEach((el) => {
        if (el.paused) el.play().catch(() => { });
      });

      reattachAllAudio(roomRef.current);

      await room.localParticipant.setMicrophoneEnabled(true);
      setIsMicEnabled(true);
      console.log("Microphone enabled");
    } catch (err) {
      console.error("Failed to enable microphone:", err);
      setConnectionError(`Mic error: ${err.message}`);
    }
  }, [room, resumeAudioContext, reattachAllAudio]);

  const stopMic = useCallback(async () => {
    if (!room) return;
    try {
      await room.localParticipant.setMicrophoneEnabled(false);
      setIsMicEnabled(false);
    } catch (err) {
      console.error("Failed to disable mic:", err);
    }
  }, [room]);

  const disconnect = useCallback(() => {
    isMountedRef.current = false;
    document.querySelectorAll('[id^="audio-"]').forEach((el) => el.remove());
    if (roomRef.current) { roomRef.current.disconnect(); roomRef.current = null; }
    setRoom(null);
    setIsConnected(false);
    onEnd?.();
  }, [onEnd]);

  const stateLabel = {
    listening: "Listening",
    thinking: "Thinking...",
    speaking: "Speaking",
    waiting: "Waiting...",
    initializing: isConnected ? "Ready" : "Connecting...",
  }[agentState] ?? (isConnected ? "Ready" : "Connecting...");

  return (
    <div className="voice-room">
      <div className="voice-room__status">
        <span className={`voice-room__dot voice-room__dot--${isConnected ? "on" : "off"}`} />
        <span>{isConnected ? "Connected" : "Connecting..."}</span>
        {isConnected && <span className="voice-room__agent-state">{stateLabel}</span>}
      </div>

      {connectionError && (
        <div className="voice-room__error">{connectionError}</div>
      )}

      <div className="voice-room__controls">
        <button
          className="btn btn--success"
          onClick={startMic}
          disabled={!isConnected || isMicEnabled}
          type="button"
        >
          {isMicEnabled ? "Mic On - Speak!" : "Start Talking"}
        </button>
        <button
          className="btn btn--danger"
          onClick={stopMic}
          disabled={!isConnected || !isMicEnabled}
          type="button"
        >
          Mute
        </button>
        <button className="btn btn--ghost" onClick={disconnect} type="button">
          End Call
        </button>
      </div>

      <div className="voice-room__panels">
        <div className="panel">
          <h3 className="panel__title">Conversation</h3>
          <div className="panel__content transcript-list">
            {transcript.length === 0 ? (
              <p className="panel__empty">Start speaking to see the transcript...</p>
            ) : (
              transcript.map((line, idx) => {
                const isUser = line.startsWith("USER:");
                const text = line.replace(/^(USER|BOT|AGENT):/, "").trim();
                return (
                  <div
                    key={idx}
                    className={`transcript-line transcript-line--${isUser ? "user" : "agent"}`}
                  >
                    <span className={`transcript-line__tag transcript-line__tag--${isUser ? "user" : "agent"}`}>
                      {isUser ? "You" : "Agent"}
                    </span>
                    <span className="transcript-line__text">{text}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {ragSources.length > 0 && (
          <div className="panel panel--sources">
            <h3 className="panel__title">RAG Sources</h3>
            <div className="panel__content">
              {ragSources.map((src, idx) => (
                <div key={idx} className="rag-source">{src}</div>
              ))}
            </div>
          </div>
        )}
      </div>

      <style>{`
        .voice-room { display: flex; flex-direction: column; gap: 1rem; }
        .voice-room__status { display: flex; align-items: center; gap: 0.5rem; font-size: 0.9rem; color: #a1a1aa; }
        .voice-room__dot { width: 10px; height: 10px; border-radius: 50%; }
        .voice-room__dot--on { background: #22c55e; box-shadow: 0 0 8px #22c55e; }
        .voice-room__dot--off { background: #ef4444; }
        .voice-room__agent-state { margin-left: auto; color: #6366f1; }
        .voice-room__error { padding: 0.75rem; background: #7f1d1d; border-radius: 8px; color: #fecaca; font-size: 0.85rem; }
        .voice-room__controls { display: flex; gap: 0.5rem; flex-wrap: wrap; }
        .btn { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.75rem 1.25rem; font-size: 1rem; font-weight: 600; border: none; border-radius: 8px; cursor: pointer; font-family: inherit; }
        .btn--success { background: #22c55e; color: white; }
        .btn--danger { background: #ef4444; color: white; }
        .btn--ghost { background: transparent; color: #a1a1aa; border: 1px solid #3f3f46; }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }
        .panel { background: #27272a; border-radius: 8px; padding: 1rem; }
        .panel__title { font-size: 0.9rem; font-weight: 600; margin: 0 0 0.5rem; }
        .panel__content { max-height: 200px; overflow-y: auto; }
        .panel__empty { color: #71717a; font-style: italic; text-align: center; }
        .transcript-list { display: flex; flex-direction: column; gap: 0.5rem; }
        .transcript-line { display: flex; gap: 0.5rem; padding: 0.5rem; background: #18181b; border-radius: 6px; }
        .transcript-line--user { border-left: 3px solid #3b82f6; }
        .transcript-line--agent { border-left: 3px solid #22c55e; }
        .transcript-line__tag { padding: 2px 6px; border-radius: 4px; font-size: 0.7rem; font-weight: 600; color: white; }
        .transcript-line__tag--user { background: #3b82f6; }
        .transcript-line__tag--agent { background: #22c55e; }
        .transcript-line__text { font-size: 0.85rem; color: #e4e4e7; flex: 1; }
        .panel--sources .panel__content { display: flex; flex-direction: column; gap: 0.5rem; }
        .rag-source { padding: 0.5rem; background: #18181b; border-radius: 4px; font-size: 0.85rem; color: #a1a1aa; }
      `}</style>
    </div>
  );
}