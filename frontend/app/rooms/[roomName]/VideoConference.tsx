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
import { ProductShowcase } from "./ProductShowcase";
import type { RpcInvocationData } from "livekit-client";
import type { DirectionsPayload } from "./ProductShowcase";

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

  const room = useRoomContext();
  const [rpcDirections, setRpcDirections] = React.useState<DirectionsPayload | null>(null);

  React.useEffect(() => {
    if (!room) return;

    const handleDirectionsRpc = async (data: RpcInvocationData): Promise<string> => {
      try {
        const payloadRaw =
          typeof data?.payload === "string" ? data.payload : JSON.stringify(data?.payload ?? {});
        const payload = JSON.parse(payloadRaw) as DirectionsPayload;
        setRpcDirections(payload);
        return "ok";
      } catch (error) {
        console.error("Error handling directions RPC", error);
        return "error";
      }
    };

    room.registerRpcMethod("client.directions", handleDirectionsRpc);
    return () => {
      room.unregisterRpcMethod("client.directions");
    };
  }, [room]);

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
        <OverlayLayer rpcDirections={rpcDirections} />
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-end px-3 pb-6 sm:px-4 lg:px-10">
          <div className="pointer-events-auto flex w-full max-w-6xl flex-col items-center gap-4">
            <ProductShowcase className="w-full" directions={rpcDirections} />
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
