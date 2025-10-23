"use client";

import {
  DisconnectButton,
  StartMediaButton,
  TrackToggle,
  useLocalParticipantPermissions,
} from "@livekit/components-react";
import { Track } from "livekit-client";

export function ControlBar() {
  const permissions = useLocalParticipantPermissions();
  const canPublishAudio = permissions?.canPublish ?? true;

  return (
    <div className="flex flex-wrap items-center justify-center gap-3 rounded-full bg-black/60 px-5 py-3 text-white shadow-lg backdrop-blur sm:flex-nowrap sm:gap-4 sm:px-6">
      <StartMediaButton className="rounded-full bg-white/10 px-4 py-2 text-sm font-semibold hover:bg-white/20">
        Enable Audio
      </StartMediaButton>
      <TrackToggle
        source={Track.Source.Microphone}
        showIcon
        disabled={!canPublishAudio}
        className="!bg-transparent hover:!bg-white/20 px-4"
      >
        Mic
      </TrackToggle>
      <DisconnectButton className="rounded-full bg-[color:var(--icecream-primary)] px-5 py-2 text-sm font-semibold hover:brightness-105">
        End Session
      </DisconnectButton>
    </div>
  );
}
