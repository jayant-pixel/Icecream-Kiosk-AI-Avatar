import { useEffect, useRef } from "react";

export type AvatarConnectionState = "inactive" | "connecting" | "connected" | "error";

interface AvatarStreamProps {
  stream: MediaStream | null;
  state: AvatarConnectionState;
  error?: string | null;
  muted?: boolean;
}

export const AvatarStream = ({ stream, state, error, muted = false }: AvatarStreamProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;

    element.muted = muted;
    element.volume = muted ? 0 : 1;

    if (!stream) {
      element.srcObject = null;
      return;
    }

    const currentStream = stream;
    if (element.srcObject !== currentStream) {
      element.srcObject = currentStream;
      element
        .play()
        .catch(() => {
          // Autoplay with audio can fail until user interacts; the Start button counts as a gesture
        });
    }
  }, [stream, muted]);

  const showOverlay = state !== "connected" || error;
  const statusLabel = (() => {
    if (error) return error;
    if (state === "connecting") return "Connecting to avatar…";
    if (state === "inactive") return "Tap start to connect to the avatar";
    return null;
  })();

  return (
    <div className="avatar-stage">
      <video ref={videoRef} className="avatar-stage__video" autoPlay playsInline />
      {showOverlay && statusLabel && (
        <div className="avatar-stage__error">{statusLabel}</div>
      )}
    </div>
  );
};
