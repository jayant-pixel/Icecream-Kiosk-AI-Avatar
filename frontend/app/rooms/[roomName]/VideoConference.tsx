import { isTrackReference } from "@livekit/components-core";
import {
  ConnectionStateToast,
  RoomAudioRenderer,
  useDataChannel,
  useTracks,
  VideoTrack,
} from "@livekit/components-react";
import { Track } from "livekit-client";
import * as React from "react";
import { ControlBar } from "./ControlBar";
import { OverlayLayer } from "./OverlayLayer";
import { ProductShowcase } from "./ProductShowcase";

export function VideoConference({
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const tracks = useTracks(
    [{ source: Track.Source.Camera, withPlaceholder: true }],
    { onlySubscribed: false }
  );

  const avatarTrack = React.useMemo(() => {
    return tracks
      .filter(isTrackReference)
      .find(
        (track) =>
          track.participant?.attributes?.agentType === "avatar" ||
          track.participant?.identity?.includes("avatar")
      );
  }, [tracks]);

  useDataChannel(
    "lk.transcription",
    React.useCallback(() => {
      /* ignore LiveKit transcription payloads to avoid noisy console warnings */
    }, [])
  );

  return (
    <div
      className="relative flex h-screen w-full flex-col overflow-hidden"
      {...props}
    >
      <div className="relative flex flex-1 items-center justify-center bg-black/30 backdrop-blur-sm">
        {avatarTrack ? (
          <VideoTrack
            className="h-full w-full max-w-[1200px] object-contain"
            trackRef={avatarTrack}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[color:var(--icecream-dark)]">
            <div className="rounded-2xl bg-white/70 px-8 py-6 text-center shadow-xl backdrop-blur">
              <p className="text-lg font-semibold">
                Waiting for Scoop to join the room…
              </p>
              <p className="text-sm opacity-70 mt-2">
                This usually takes a few seconds.
              </p>
            </div>
          </div>
        )}
        <OverlayLayer />
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-end px-3 pb-6 sm:px-4 lg:px-10">
          <div className="pointer-events-auto flex w-full max-w-6xl flex-col items-center gap-4">
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
