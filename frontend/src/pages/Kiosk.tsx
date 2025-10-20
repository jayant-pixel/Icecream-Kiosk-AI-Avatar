import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import StreamingAvatar, { AvatarQuality, StreamingEvents, type StartAvatarResponse } from "@heygen/streaming-avatar";
import { Hero } from "../components/Hero";
import { AvatarStream, type AvatarConnectionState } from "../components/AvatarStream";
import { OverlayManager, type Overlay } from "../components/OverlayManager";
import { MicBar } from "../components/MicBar";
import { brainRespond, newSession, type SessionDescriptor } from "../lib/api";
import type { AssistantEvent, CartItem } from "../lib/types";

const DEFAULT_AVATAR_ID = import.meta.env.VITE_HEYGEN_AVATAR_ID;
const HEYGEN_BASE_URL = import.meta.env.VITE_HEYGEN_BASE_URL ?? "https://api.heygen.com";

type ActiveSession = {
  sessionId: string;
  accessToken: string;
  expiresAt?: number | null;
};

const buildStatusSpeech = (events: AssistantEvent[], fallback: string) => {
  if (events.length === 0) {
    return fallback;
  }
  return events[events.length - 1]?.spokenPrompt ?? fallback;
};

export const Kiosk = () => {
  const [started, setStarted] = useState(false);
  const [sessionDescriptor, setSessionDescriptor] = useState<SessionDescriptor | null>(null);
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [connectionState, setConnectionState] = useState<AvatarConnectionState>("inactive");
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [threadId, setThreadId] = useState<string | undefined>();
  const [status, setStatus] = useState("Ready when you are!");
  const [processing, setProcessing] = useState(false);
  const [outputMuted, setOutputMuted] = useState(false);
  const [greeted, setGreeted] = useState(false);

  const avatarRef = useRef<StreamingAvatar | null>(null);

  const greetingPrompt = useMemo(
    () => "Greet the kiosk guest with a warm, one-sentence welcome to Scoop Haven.",
    [],
  );

  const applyAssistantEvents = useCallback((events: AssistantEvent[]) => {
    if (events.length === 0) {
      setOverlay(null);
      return;
    }

    const event = events[events.length - 1];

    switch (event.type) {
      case "show_products":
        setOverlay({ type: "products", products: event.products });
        break;
      case "directions":
        setOverlay({ type: "directions", directions: event.directions });
        break;
      case "checkout":
        setOverlay({ type: "checkout", receipt: event.receipt });
        break;
      case "add_to_cart":
        setCart(event.cart);
        setOverlay(null);
        break;
      default:
        setOverlay(null);
        break;
    }
  }, []);

  const resetSession = useCallback(() => {
    avatarRef.current = null;
    setActiveSession(null);
    setSessionDescriptor(null);
    setStream(null);
    setConnectionState("inactive");
    setConnectionError(null);
    setOverlay(null);
    setCart([]);
    setThreadId(undefined);
    setStatus("Ready when you are!");
    setOutputMuted(false);
    setGreeted(false);
    setStarted(false);
  }, []);

  const handleUtterance = useCallback(
    async (utterance: string) => {
      if (!activeSession || connectionState !== "connected" || processing) {
        return;
      }

      setProcessing(true);
      setStatus("Thinking…");
      try {
        const response = await brainRespond(utterance, cart, threadId, activeSession);
        setThreadId(response.threadId);
        setCart(response.cart);
        applyAssistantEvents(response.events);

        const spoken = buildStatusSpeech(response.events, response.response);
        setStatus(spoken);
      } catch (error) {
        console.error("Assistant error", error);
        setStatus("Something went wrong. Please try again.");
      } finally {
        setProcessing(false);
      }
    },
    [activeSession, applyAssistantEvents, cart, connectionState, processing, threadId],
  );

  const startSession = useCallback(async () => {
    if (processing) {
      return;
    }

    const avatarIdToUse = DEFAULT_AVATAR_ID ?? sessionDescriptor?.avatarId;
    if (!avatarIdToUse) {
      alert("Missing avatar ID. Please set VITE_HEYGEN_AVATAR_ID in your .env file.");
      return;
    }

    setProcessing(true);
    setConnectionError(null);
    setStatus("Connecting to the avatar…");

    try {
      const newDescriptor = await newSession(avatarIdToUse);
      setSessionDescriptor(newDescriptor);

      if (avatarRef.current) {
        try {
          await avatarRef.current.stopAvatar();
        } catch (error) {
          console.warn("Failed to stop previous session", error);
        }
      }

      const avatar = new StreamingAvatar({ token: newDescriptor.token, basePath: HEYGEN_BASE_URL });
      avatarRef.current = avatar;

      setConnectionState("connecting");
      setOverlay(null);
      setOutputMuted(false);

      avatar.on(StreamingEvents.STREAM_READY, ({ detail }) => {
        setStream(detail);
        setConnectionState("connected");
        setStatus("Connected. Say hi or press Tap to Talk!");
      });

      avatar.on(StreamingEvents.STREAM_DISCONNECTED, () => {
        resetSession();
      });

      const sessionResponse: StartAvatarResponse = await avatar.createStartAvatar({
        avatarName: newDescriptor.avatarId,
        quality: AvatarQuality.High,
        language: "en",
      });

      setActiveSession({
        sessionId: sessionResponse.session_id,
        accessToken: sessionResponse.access_token,
        expiresAt: sessionResponse.session_duration_limit,
      });

      setStarted(true);
    } catch (error) {
      console.error("Failed to start avatar session", error);
      setConnectionError(
        error instanceof Error ? error.message : "Unable to connect to the avatar.",
      );
      setStatus("Unable to connect. Please try again.");
      resetSession();
    } finally {
      setProcessing(false);
    }
  }, [processing, resetSession, sessionDescriptor]);

  const endSession = useCallback(async () => {
    setProcessing(true);
    try {
      await avatarRef.current?.stopAvatar();
    } catch (error) {
      console.warn("Error stopping session", error);
    } finally {
      resetSession();
      setProcessing(false);
    }
  }, [resetSession]);

  const toggleOutputMute = useCallback(() => {
    setOutputMuted((prev) => !prev);
  }, []);

  useEffect(() => {
    if (connectionState !== "connected" || !activeSession || greeted) {
      return;
    }

    const runGreeting = async () => {
      try {
        const greeting = await brainRespond(greetingPrompt, cart, threadId, activeSession);
        setThreadId(greeting.threadId);
        setCart(greeting.cart);
        applyAssistantEvents(greeting.events);
        const spoken = buildStatusSpeech(greeting.events, greeting.response);
        setStatus(spoken);
      } catch (error) {
        console.error("Greeting failed", error);
      } finally {
        setGreeted(true);
      }
    };

    runGreeting().catch((error) => console.error(error));
  }, [activeSession, applyAssistantEvents, cart, connectionState, greeted, greetingPrompt, threadId]);

  useEffect(
    () => () => {
      if (avatarRef.current) {
        void avatarRef.current.stopAvatar().catch(() => undefined);
      }
    },
    [],
  );

  if (!started || !sessionDescriptor || !activeSession) {
    return (
      <div className="kiosk">
        <Hero onStart={startSession} />
      </div>
    );
  }

  return (
    <div className="kiosk">
      <AvatarStream stream={stream} state={connectionState} error={connectionError} muted={outputMuted} />

      <OverlayManager
        overlay={overlay}
        onAddToCart={async (productId) => {
          setOverlay(null);
          await handleUtterance(`Add ${productId} to my cart`);
        }}
        onClose={() => setOverlay(null)}
      />

      <div className="kiosk__status">
        <span>{status}</span>
      </div>

      <div className="kiosk__controls">
        <div className="session-controls">
          <button
            type="button"
            className="button button--secondary"
            onClick={endSession}
            disabled={processing || connectionState === "inactive"}
          >
            End session
          </button>
          <button
            type="button"
            className="button"
            onClick={toggleOutputMute}
            disabled={connectionState !== "connected"}
          >
            {outputMuted ? "Unmute avatar" : "Mute avatar"}
          </button>
        </div>

        <MicBar disabled={processing || connectionState !== "connected"} onUtterance={handleUtterance} />
      </div>
    </div>
  );
};
