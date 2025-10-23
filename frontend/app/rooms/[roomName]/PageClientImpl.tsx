"use client";

import { randomString } from "@/lib/client-utils";
import { DebugMode } from "@/lib/Debug";
import { RecordingIndicator } from "@/lib/RecordingIndicator";
import { ConnectionDetails } from "@/lib/types";
import { LiveKitRoom, LocalUserChoices } from "@livekit/components-react";
import { Room, RoomConnectOptions, RoomOptions } from "livekit-client";
import { useRouter } from "next/navigation";
import React from "react";
import { RoomContext } from "./RoomContext";
import { VideoConference } from "./VideoConference";

const CONN_DETAILS_ENDPOINT =
  process.env.NEXT_PUBLIC_CONN_DETAILS_ENDPOINT ??
  "/api/livekit/connection-details";
const IDENTITY_STORAGE_KEY = "icecream-kiosk-identity";

function getOrCreateIdentity(): string {
  if (typeof window === "undefined") {
    return `guest-${randomString(6)}`;
  }
  const existing = window.sessionStorage.getItem(IDENTITY_STORAGE_KEY);
  if (existing) return existing;
  const next = `guest-${randomString(6)}`;
  window.sessionStorage.setItem(IDENTITY_STORAGE_KEY, next);
  return next;
}

export function PageClientImpl(props: {
  roomName: string;
  region?: string;
  hq: boolean;
  codec: string;
}) {
  const [connectionDetails, setConnectionDetails] = React.useState<
    ConnectionDetails | null
  >(null);
  const [userChoices, setUserChoices] = React.useState<
    LocalUserChoices | null
  >(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const identityRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    const joinRoom = async () => {
      try {
        const identity = getOrCreateIdentity();
        identityRef.current = identity;

        const url = new URL(CONN_DETAILS_ENDPOINT, window.location.origin);
        url.searchParams.append("roomName", props.roomName);
        url.searchParams.append("participantName", identity);
        if (props.region) {
          url.searchParams.append("region", props.region);
        }
        const response = await fetch(url.toString());
        if (!response.ok) {
          throw new Error("Unable to prepare LiveKit connection");
        }
        const details = (await response.json()) as ConnectionDetails;
        if (cancelled) return;

        setConnectionDetails(details);
        setUserChoices({
          username: identity,
          audioEnabled: true,
          videoEnabled: false,
          audioDeviceId: "",
          videoDeviceId: "",
        });

        // Ensure Scoop avatar is dispatched (idempotent).
        fetch("/api/livekit/request-agent", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ room: props.roomName }),
        }).catch((err) => {
          console.warn("Failed to ensure agent dispatch", err);
        });
      } catch (err) {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : "Unable to join the room";
        setError(message);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    joinRoom();

    return () => {
      cancelled = true;
    };
  }, [props.roomName, props.region]);

  const router = useRouter();
  const handleOnLeave = React.useCallback(async () => {
    try {
      await fetch(
        `/api/livekit/stop-agent?room-name=${encodeURIComponent(
          props.roomName
        )}`,
        { method: "DELETE" }
      );
    } catch (err) {
      console.warn("Failed to stop agent on leave", err);
    }
    router.push("/");
  }, [props.roomName, router]);

  const roomOptions = React.useMemo<RoomOptions>(() => {
    return {
      publishDefaults: {
        videoSimulcastLayers: [],
      },
      adaptiveStream: { pixelDensity: "screen" },
    };
  }, []);

  const connectOptions = React.useMemo<RoomConnectOptions>(() => {
    return {
      autoSubscribe: true,
    };
  }, []);

  const room = React.useMemo(() => new Room(roomOptions), [roomOptions]);

  if (loading) {
    return (
      <main className="icecream-room flex items-center justify-center text-[color:var(--icecream-dark)]">
        <p className="animate-pulse text-lg">Setting up your scoop session…</p>
      </main>
    );
  }

  if (error || !connectionDetails || !userChoices) {
    return (
      <main className="icecream-room flex items-center justify-center text-center text-[color:var(--icecream-dark)] px-6">
        <div className="max-w-md space-y-4">
          <h2 className="text-2xl font-semibold">Something went wrong</h2>
          <p className="text-base opacity-80">
            {error ?? "We couldn’t prepare the session. Please try again."}
          </p>
          <button
            type="button"
            onClick={() => router.push("/")}
            className="inline-flex h-11 px-6 items-center justify-center rounded-xl bg-[color:var(--icecream-primary)] text-white font-semibold shadow-md hover:brightness-105 transition"
          >
            Return to Welcome
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="icecream-room">
      <RoomContext.Provider value={props.roomName}>
        <LiveKitRoom
          connect
          room={room}
          token={connectionDetails.participantToken}
          serverUrl={connectionDetails.serverUrl}
          connectOptions={connectOptions}
          video={false}
          audio={userChoices.audioEnabled}
          onDisconnected={handleOnLeave}
          data-lk-theme="default"
        >
          <VideoConference />
          <DebugMode />
          <RecordingIndicator />
        </LiveKitRoom>
      </RoomContext.Provider>
    </main>
  );
}
