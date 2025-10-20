"use client";

import "@livekit/components-styles";

import {
  LiveKitRoom,
  GridLayout,
  useTracks,
  useRoomContext,
  StartMediaButton,
  VideoTrack,
} from "@livekit/components-react";
import type { TrackReferenceOrPlaceholder } from "@livekit/components-react";
import { RoomEvent, Track, type RemoteParticipant } from "livekit-client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { OverlayDispatcher, type OverlayMessage } from "@/src/components/OverlayDispatcher";

const backendBaseUrl = (process.env.NEXT_PUBLIC_BACKEND_URL ?? "").replace(/\/$/, "");

interface TokenResponse {
  url: string;
  token: string;
}

const useAgentParticipant = () => {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.Microphone, withPlaceholder: false },
    ],
    { onlySubscribed: true },
  );

  const agent = useMemo(() => {
    const participants = tracks
      .map((track) => track.participant)
      .filter((participant): participant is RemoteParticipant => Boolean(participant?.isRemote)) as RemoteParticipant[];

    const explicit = participants.find((participant) => {
      if (!participant) return false;
      if (participant.identity === "agent") return true;
      if (!participant.metadata) return false;
      try {
        const meta = JSON.parse(participant.metadata);
        return meta?.role === "agent";
      } catch {
        return false;
      }
    });

    return explicit ?? participants[0] ?? null;
  }, [tracks]);

  const agentTracks = useMemo(() => {
    if (!agent) return [] as TrackReferenceOrPlaceholder[];
    return tracks.filter((track) => {
      if (track.participant?.sid !== agent.sid) {
        return false;
      }
      const publicationKind = track.publication?.kind;
      if (publicationKind === Track.Kind.Video) {
        return true;
      }
      return track.source === Track.Source.Camera;
    });
  }, [agent, tracks]);

  return { agent, agentTracks };
};

const MicButton = () => {
  const room = useRoomContext();
  const [enabled, setEnabled] = useState(false);

  const toggleMic = useCallback(async () => {
    if (!room) {
      return;
    }
    const next = !enabled;
    await room.localParticipant.setMicrophoneEnabled(next);
    setEnabled(next);
  }, [enabled, room]);

  useEffect(() => {
    if (!room) {
      return;
    }
    setEnabled(room.localParticipant.isMicrophoneEnabled);
  }, [room]);

  if (!room) {
    return null;
  }

  return (
    <button
      type="button"
      className={`mic-button ${enabled ? "mic-button--active" : ""}`.trim()}
      onClick={toggleMic}
      aria-pressed={enabled}
    >
      {enabled ? "Stop Listening" : "Start Listening"}
    </button>
  );
};

const AgentStage = () => {
  const { agentTracks } = useAgentParticipant();

  return (
    <div className="session-room__video">
      {agentTracks.length === 0 ? (
        <div className="session-room__waiting" role="status" aria-live="polite">
          Waiting for the avatar to join...
        </div>
      ) : (
        <GridLayout tracks={agentTracks} className="session-room__grid">
          {(trackRef) => (
            <div
              key={`${trackRef.participant.sid}-${trackRef.source}`}
              className="session-room__tile"
            >
              <VideoTrack trackRef={trackRef} className="session-room__video-element" />
            </div>
          )}
        </GridLayout>
      )}
    </div>
  );
};

const EndSessionButton = () => {
  const room = useRoomContext();
  const router = useRouter();

  const handleEnd = useCallback(() => {
    if (!room) {
      return;
    }
    room.disconnect();
    router.push("/");
  }, [room, router]);

  if (!room) {
    return null;
  }

  return (
    <button type="button" className="session-end-button" onClick={handleEnd}>
      End Session
    </button>
  );
};

const SessionShell = ({ children }: { children: React.ReactNode }) => (
  <div className="session-shell">
    <div className="session-shell__backdrop" />
    {children}
  </div>
);

const RoomEventHandlers = ({ onOverlay }: { onOverlay: (message: OverlayMessage | null) => void }) => {
  const room = useRoomContext();
  const decoder = useMemo(() => new TextDecoder(), []);

  useEffect(() => {
    if (!room) {
      return;
    }

    const handleData = (payload: Uint8Array) => {
      try {
        const decoded = JSON.parse(decoder.decode(payload));
        if (decoded?.type === "ui.overlay") {
          onOverlay(decoded as OverlayMessage);
        }
      } catch (error) {
        console.warn("Ignoring malformed data track message", error);
      }
    };

    room.on(RoomEvent.DataReceived, handleData);
    return () => {
      room.off(RoomEvent.DataReceived, handleData);
    };
  }, [decoder, onOverlay, room]);

  useEffect(() => {
    if (!room) {
      return;
    }

    const resetOverlay = () => {
      onOverlay(null);
    };

    room.on(RoomEvent.Disconnected, resetOverlay);
    return () => {
      room.off(RoomEvent.Disconnected, resetOverlay);
    };
  }, [onOverlay, room]);

  return null;
};

export default function SessionPage() {
  const [livekitUrl, setLivekitUrl] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<OverlayMessage | null>(null);
  useEffect(() => {
    let cancelled = false;
    const identity = `kiosk-${crypto.randomUUID().slice(0, 8)}`;
    const controller = new AbortController();

    const fetchToken = async () => {
      try {
        const response = await fetch(`${backendBaseUrl}/api/livekit/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ identity, name: identity }),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Token request failed with status ${response.status}`);
        }
        const data = (await response.json()) as TokenResponse;
        if (!cancelled) {
          setLivekitUrl(data.url);
          setToken(data.token);
        }
      } catch (error) {
        if (!cancelled) {
          console.error("Failed to fetch LiveKit token", error);
        }
      }
    };

    fetchToken();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  if (!livekitUrl || !token) {
    return (
      <SessionShell>
        <div className="session-loading" role="status" aria-live="polite">
          Starting your session…
        </div>
      </SessionShell>
    );
  }

  return (
    <SessionShell>
      <LiveKitRoom
        serverUrl={livekitUrl}
        token={token}
        connect
        audio
        video
        onDisconnected={() => setOverlay(null)}
        data-lk-theme="default"
        className="session-room"
      >
        <RoomEventHandlers onOverlay={setOverlay} />
        <AgentStage />
        <div className="session-room__controls">
          <StartMediaButton label="Enable Audio" />
          <MicButton />
          <EndSessionButton />
        </div>
        <OverlayDispatcher message={overlay} />
      </LiveKitRoom>
    </SessionShell>
  );
}
