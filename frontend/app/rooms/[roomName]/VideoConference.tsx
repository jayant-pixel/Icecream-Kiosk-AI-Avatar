"use client";

import { isTrackReference } from "@livekit/components-core";
import {
  ConnectionStateToast,
  RoomAudioRenderer,
  useDataChannel,
  useRoomContext,
  useTracks,
  VideoTrack,
} from "@livekit/components-react";
import { Track } from "livekit-client";
import * as React from "react";
import { ControlBar } from "./ControlBar";
import { OverlayLayer } from "./OverlayLayer";

// NOTE: ProductShowcase is kept for the UI chrome (menu grid / detail card /
// "added" toast) it renders, but its RPC handler (client.products) was dead —
// the agent never calls that method. If you want to remove ProductShowcase
// entirely, delete the import and the <ProductShowcase> element below.
import { ProductShowcase } from "./ProductShowcase";

const CLIENT_SESSION_END_GRACE_MS = 10_000;

export function VideoConference({
  sessionDeadlineAt,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  sessionDeadlineAt?: number;
}) {
  const tracks = useTracks(
    [{ source: Track.Source.Camera, withPlaceholder: true }],
    { onlySubscribed: false }
  );

  const avatarTrack = React.useMemo(
    () =>
      tracks
        .filter(isTrackReference)
        .find(
          (t) =>
            t.participant?.attributes?.agentType === "avatar" ||
            t.participant?.identity?.includes("avatar")
        ),
    [tracks]
  );

  // Suppress LiveKit's internal transcription channel from cluttering the console.
  useDataChannel(
    "lk.transcription",
    React.useCallback(() => {
      /* intentionally ignored */
    }, [])
  );

  // All RPC registration (client.directions, client.cartUpdated, etc.) now lives
  // inside OverlayLayer. VideoConference no longer touches RPC or room directly,
  // which eliminates the duplicate client.directions registration that previously
  // caused the directions panel to silently fail.

  return (
    <div
      className="relative flex h-screen w-full flex-col overflow-hidden"
      {...props}
    >
      <div className="relative flex flex-1 items-start justify-center bg-black">
        <SessionTimer deadlineAt={sessionDeadlineAt} />

        {avatarTrack ? (
          <div className="absolute inset-0 flex overflow-hidden items-start justify-center bg-black">
            <VideoTrack
              className="h-full w-auto object-cover"
              style={{ filter: "contrast(1.1) saturate(1.2)" }}
              trackRef={avatarTrack}
            />
          </div>
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[color:var(--icecream-dark)]">
            <div className="rounded-[32px] border border-black/5 bg-white px-10 py-8 text-center shadow-2xl">
              <p className="text-xl font-bold text-[color:var(--icecream-dark)]">
                Waiting for Scoop to join the room…
              </p>
              <p className="text-sm font-medium text-black/60 mt-2">
                This usually takes a few seconds.
              </p>
            </div>
          </div>
        )}

        {/*
         * OverlayLayer is the single authoritative UI consumer. It owns:
         *   - product grid / detail cards (data channel + client.menuLoaded RPC)
         *   - flavor & topping pickers (data channel + client.flavors/toppingsLoaded RPC)
         *   - cart panel (data channel + client.cartUpdated RPC)
         *   - directions panel (data channel + client.directions RPC)
         *   - upgrade banner (data channel)
         *
         * No prop threading required — all channels are handled internally.
         */}
        <OverlayLayer />

        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-end px-3 pb-6 sm:px-4 lg:px-10">
          <div className="pointer-events-auto flex w-full max-w-6xl flex-col items-center gap-4">
            {/* ProductShowcase renders the menu-grid / detail / added-to-tray panels.
                Its internal client.products RPC handler is dead (agent never calls it),
                so these panels are only visible if this agent is updated to send that RPC.
                Safe to remove if you no longer need this panel. */}
            <ProductShowcase className="w-full" />
          </div>
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-0 flex justify-center px-4 pb-6 sm:pb-10 pointer-events-none">
        <div className="pointer-events-auto">
          <ControlBar />
        </div>
      </div>

      <RoomAudioRenderer />
      <ConnectionStateToast />
    </div>
  );
}

function SessionTimer({ deadlineAt }: { deadlineAt?: number }) {
  const room = useRoomContext();
  const [remainingMs, setRemainingMs] = React.useState(() =>
    getRemainingMs(deadlineAt)
  );
  const hasExpiredRef = React.useRef(false);
  const disconnectTimeoutRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    hasExpiredRef.current = false;
    setRemainingMs(getRemainingMs(deadlineAt));
    if (disconnectTimeoutRef.current !== null) {
      window.clearTimeout(disconnectTimeoutRef.current);
      disconnectTimeoutRef.current = null;
    }
    if (!deadlineAt) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setRemainingMs(getRemainingMs(deadlineAt));
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [deadlineAt]);

  React.useEffect(() => {
    if (!room || hasExpiredRef.current || remainingMs > 0) {
      return;
    }
    hasExpiredRef.current = true;
    disconnectTimeoutRef.current = window.setTimeout(() => {
      void room.disconnect();
    }, CLIENT_SESSION_END_GRACE_MS);
    return () => {
      if (disconnectTimeoutRef.current !== null) {
        window.clearTimeout(disconnectTimeoutRef.current);
        disconnectTimeoutRef.current = null;
      }
    };
  }, [remainingMs, room]);

  if (!deadlineAt) {
    return null;
  }

  const isExpired = remainingMs <= 0;
  const isUrgent = remainingMs > 0 && remainingMs <= 60_000;

  return (
    <div className="pointer-events-none absolute right-4 top-4 z-20 sm:right-6 sm:top-6">
      <div
        className={[
          "rounded-full border px-4 py-2 text-sm font-semibold shadow-lg backdrop-blur-md",
          isExpired
            ? "border-white/20 bg-black/75 text-white"
            : isUrgent
              ? "border-red-300/70 bg-red-500/85 text-white"
              : "border-white/35 bg-black/55 text-white",
        ].join(" ")}
      >
        {isExpired ? "Session ended" : `Time left ${formatRemainingTime(remainingMs)}`}
      </div>
    </div>
  );
}

function getRemainingMs(deadlineAt?: number): number {
  if (!deadlineAt) {
    return 0;
  }
  return Math.max(deadlineAt - Date.now(), 0);
}

function formatRemainingTime(remainingMs: number): string {
  const totalSeconds = Math.max(Math.ceil(remainingMs / 1000), 0);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
