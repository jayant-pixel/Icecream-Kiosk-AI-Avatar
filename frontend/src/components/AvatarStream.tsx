import React, { useEffect, useRef } from "react";
import { connect, Room } from "livekit-client";
import StreamingAvatar from "@heygen/streaming-avatar";
import type { SessionDetails } from "../lib/api";

type AvatarStreamProps = {
  session: SessionDetails;
  avatarId: string;
  onReady: (deps: { room: Room; avatar: StreamingAvatar }) => void;
};

export function AvatarStream({ session, avatarId, onReady }: AvatarStreamProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    let room: Room | null = null;
    let avatar: StreamingAvatar | null = null;
    let cancelled = false;

    (async () => {
      try {
        room = await connect(session.livekitUrl, session.accessToken);
        if (cancelled) {
          room.disconnect();
          return;
        }

        room.on("trackSubscribed", (track) => {
          if (track.kind === "video" && videoRef.current) {
            videoRef.current.srcObject = new MediaStream([track.mediaStreamTrack]);
          }
        });

        avatar = new StreamingAvatar({ token: session.accessToken });
        await avatar.createStartAvatar({
          avatarId,
          version: "v3",
          language: "en",
          quality: "high",
        });

        if (!cancelled) {
          onReady({ room, avatar });
        }
      } catch (error) {
        console.error("Failed to initialise avatar stream", error);
      }
    })();

    return () => {
      cancelled = true;
      try {
        avatar?.stop?.();
      } catch (error) {
        console.warn("avatar stop failed", error);
      }
      try {
        room?.disconnect?.();
      } catch (error) {
        console.warn("room disconnect failed", error);
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
    };
  }, [session, avatarId, onReady]);

  return <video ref={videoRef} autoPlay muted playsInline className="avatar-stream" />;
}
