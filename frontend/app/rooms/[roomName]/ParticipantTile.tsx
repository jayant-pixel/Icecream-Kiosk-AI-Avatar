import * as React from "react";
import type { Participant } from "livekit-client";
import { Track, ParticipantKind } from "livekit-client";
import type {
  ParticipantClickEvent,
  TrackReferenceOrPlaceholder,
} from "@livekit/components-core";
import {
  isTrackReference,
  isTrackReferencePinned,
} from "@livekit/components-core";
import {
  ConnectionQualityIndicator,
  ParticipantName,
  TrackMutedIndicator,
  ParticipantPlaceholder,
  LockLockedIcon,
  ScreenShareIcon,
  FocusToggle,
  VideoTrack,
  AudioTrack,
  useParticipantTile,
  useIsEncrypted,
  ParticipantContext,
  TrackRefContext,
  useEnsureTrackRef,
  useFeatureContext,
  useMaybeLayoutContext,
  useMaybeParticipantContext,
  useMaybeTrackRefContext,
} from "@livekit/components-react";
import Image from "next/image";

/**
 * The `ParticipantContextIfNeeded` component only creates a `ParticipantContext`
 * if there is no `ParticipantContext` already.
 * @example
 * ```tsx
 * <ParticipantContextIfNeeded participant={trackReference.participant}>
 *  ...
 * </ParticipantContextIfNeeded>
 * ```
 * @public
 */
export function ParticipantContextIfNeeded(
  props: React.PropsWithChildren<{
    participant?: Participant;
  }>
) {
  const hasContext = !!useMaybeParticipantContext();
  return props.participant && !hasContext ? (
    <ParticipantContext.Provider value={props.participant}>
      {props.children}
    </ParticipantContext.Provider>
  ) : (
    <>{props.children}</>
  );
}

/**
 * Only create a `TrackRefContext` if there is no `TrackRefContext` already.
 * @internal
 */
export function TrackRefContextIfNeeded(
  props: React.PropsWithChildren<{
    trackRef?: TrackReferenceOrPlaceholder;
  }>
) {
  const hasContext = !!useMaybeTrackRefContext();
  return props.trackRef && !hasContext ? (
    <TrackRefContext.Provider value={props.trackRef}>
      {props.children}
    </TrackRefContext.Provider>
  ) : (
    <>{props.children}</>
  );
}

/** @public */
export interface ParticipantTileProps
  extends React.HTMLAttributes<HTMLDivElement> {
  /** The track reference to display. */
  trackRef?: TrackReferenceOrPlaceholder;
  disableSpeakingIndicator?: boolean;

  onParticipantClick?: (event: ParticipantClickEvent) => void;
}

/**
 * The `ParticipantTile` component is the base utility wrapper for displaying a visual representation of a participant.
 * This component can be used as a child of the `TrackLoop` component or by passing a track reference as property.
 *
 * @example Using the `ParticipantTile` component with a track reference:
 * ```tsx
 * <ParticipantTile trackRef={trackRef} />
 * ```
 * @example Using the `ParticipantTile` component as a child of the `TrackLoop` component:
 * ```tsx
 * <TrackLoop>
 *  <ParticipantTile />
 * </TrackLoop>
 * ```
 * @public
 */
export const ParticipantTile: (
  props: ParticipantTileProps & React.RefAttributes<HTMLDivElement>
) => React.ReactNode = /* @__PURE__ */ React.forwardRef<
  HTMLDivElement,
  ParticipantTileProps
>(function ParticipantTile(
  {
    trackRef,
    children,
    onParticipantClick,
    disableSpeakingIndicator,
    ...htmlProps
  }: ParticipantTileProps,
  ref
) {
  const trackReference = useEnsureTrackRef(trackRef);

  const { elementProps } = useParticipantTile<HTMLDivElement>({
    htmlProps,
    disableSpeakingIndicator,
    onParticipantClick,
    trackRef: trackReference,
  });
  const isEncrypted = useIsEncrypted(trackReference.participant);
  const layoutContext = useMaybeLayoutContext();

  const autoManageSubscription = useFeatureContext()?.autoSubscription;

  const handleSubscribe = React.useCallback(
    (subscribed: boolean) => {
      if (
        trackReference.source &&
        !subscribed &&
        layoutContext &&
        layoutContext.pin.dispatch &&
        isTrackReferencePinned(trackReference, layoutContext.pin.state)
      ) {
        layoutContext.pin.dispatch({ msg: "clear_pin" });
      }
    },
    [trackReference, layoutContext]
  );

  // For Avatars: Hide agent-only participant: if this participant is an agent with no avatar output, skip rendering
  const participant = trackReference.participant;
  const isAgent =
    participant.isAgent ?? participant.kind === ParticipantKind.AGENT;
  const publishOnBehalf = participant.attributes?.["lk.publish_on_behalf"];
  const agentType = participant.attributes?.["agentType"];
  if (isAgent && !publishOnBehalf && agentType === "avatar") {
    // This is the main agent (no `lk.publish_on_behalf` set), so we don't render it at all
    return null;
  }

  const isAvatarAgent =
    isAgent &&
    agentType === "avatar" &&
    trackReference.participant.identity?.includes("avatar");

  const isNotAvatarAgent =
    isAgent &&
    agentType !== "avatar" &&
    !trackReference.participant.identity?.includes("avatar");

  function renderPlaceholder() {
    if (isAvatarAgent) {
      return <ParticipantPlaceholder />;
    } else if (isNotAvatarAgent) {
      return (
        <Image
          src={process.env.NEXT_PUBLIC_VOICE_AGENT_IMAGE || ""}
          alt="Agent Profile"
          fill
          quality={100}
          style={{ objectFit: "contain" }}
        />
      );
    } else {
      return <ParticipantPlaceholder />;
    }
  }

  return (
    <div ref={ref} style={{ position: "relative" }} {...elementProps}>
      <TrackRefContextIfNeeded trackRef={trackReference}>
        <ParticipantContextIfNeeded participant={trackReference.participant}>
          {children ?? (
            <>
              {isTrackReference(trackReference) &&
              (trackReference.publication?.kind === "video" ||
                trackReference.source === Track.Source.Camera ||
                trackReference.source === Track.Source.ScreenShare) ? (
                <VideoTrack
                  trackRef={trackReference}
                  onSubscriptionStatusChanged={handleSubscribe}
                  manageSubscription={autoManageSubscription}
                />
              ) : (
                isTrackReference(trackReference) && (
                  <AudioTrack
                    trackRef={trackReference}
                    onSubscriptionStatusChanged={handleSubscribe}
                  />
                )
              )}
              <div className="lk-participant-placeholder">
                {trackReference.participant?.name ===
                (process.env.NEXT_PUBLIC_HOST_NAME || "Kyle Campbell") ? (
                  <Image
                    src={
                      process.env.NEXT_PUBLIC_HOST_IMAGE || "/images/garth.png"
                    }
                    alt="Agent Profile"
                    fill
                    quality={100}
                    style={{ objectFit: "cover" }}
                  />
                ) : (
                  renderPlaceholder()
                )}
              </div>
              <div className="lk-participant-metadata">
                <div className="lk-participant-metadata-item">
                  {trackReference.source === Track.Source.Camera ? (
                    <>
                      {isEncrypted && (
                        <LockLockedIcon style={{ marginRight: "0.25rem" }} />
                      )}
                      <TrackMutedIndicator
                        trackRef={{
                          participant: trackReference.participant,
                          source: Track.Source.Microphone,
                        }}
                        show={"muted"}
                      ></TrackMutedIndicator>
                      <ParticipantName />
                    </>
                  ) : (
                    <>
                      <ScreenShareIcon style={{ marginRight: "0.25rem" }} />
                      <ParticipantName>&apos;s screen</ParticipantName>
                    </>
                  )}
                </div>
                <ConnectionQualityIndicator className="lk-participant-metadata-item" />
              </div>
            </>
          )}
          <FocusToggle trackRef={trackReference} />
        </ParticipantContextIfNeeded>
      </TrackRefContextIfNeeded>
    </div>
  );
});
