"use client";

import "@livekit/components-styles";

import { LiveKitRoom, GridLayout, ParticipantTile, useTracks, useRoomContext } from "@livekit/components-react";
import type { TrackReferenceOrPlaceholder } from "@livekit/components-react";
import { Room, Track, type RemoteParticipant } from "livekit-client";
import { useCallback, useEffect, useMemo, useState } from "react";

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
    return tracks.filter((track) => track.participant?.sid === agent.sid && track.source === Track.Source.Camera);
  }, [agent, tracks]);

  return { agent, agentTracks };
};

const MicButton = () => {
  const room = useRoomContext();
  const [enabled, setEnabled] = useState(false);

  const toggleMic = useCallback(async () => {
    const next = !enabled;
    await room.localParticipant.setMicrophoneEnabled(next);
    setEnabled(next);
  }, [enabled, room]);

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

const SessionShell = ({ children }: { children: React.ReactNode }) => (
  <div className="session-shell">
    <div className="session-shell__backdrop" />
    {children}
  </div>
);

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

  const handleConnected = useCallback((room: Room) => {
    room.on("dataReceived", (payload) => {
      try {
        const decoded = JSON.parse(new TextDecoder().decode(payload));
        if (decoded?.type === "ui.overlay") {
          setOverlay(decoded as OverlayMessage);
        }
      } catch (error) {
        console.warn("Ignoring malformed data track message", error);
      }
    });
  }, []);

  const handleDisconnected = useCallback(() => {
    setOverlay(null);
  }, []);

  const { agentTracks } = useAgentParticipant();

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
        onConnected={handleConnected}
        onDisconnected={handleDisconnected}
        data-lk-theme="default"
        className="session-room"
      >
        <div className="session-room__video">
          <GridLayout tracks={agentTracks} className="session-room__grid">
            {(trackRef) => (
              <ParticipantTile
                key={`${trackRef.participant.sid}-${trackRef.source}`}
                trackRef={trackRef}
                className="session-room__tile"
              />
            )}
          </GridLayout>
        </div>
        <div className="session-room__controls">
          <MicButton />
        </div>
        <OverlayDispatcher message={overlay} />
      </LiveKitRoom>
    </SessionShell>
  );
}
