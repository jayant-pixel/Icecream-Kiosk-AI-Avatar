import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Hero } from "../components/Hero";
import { AvatarStream } from "../components/AvatarStream";
import { OverlayManager, Overlay } from "../components/OverlayManager";
import { MicBar } from "../components/MicBar";
import { brainRespond, CartLine, newSession, speak } from "../lib/api";
import type { SessionDetails } from "../lib/api";

export function Kiosk() {
  const [started, setStarted] = useState(false);
  const [session, setSession] = useState<SessionDetails | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  const avatarId = useMemo(() => {
    return (import.meta as any).env?.VITE_HEYGEN_AVATAR_ID || "YOUR_AVATAR_ID";
  }, []);

  useEffect(() => {
    const handleAdd = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string }>).detail;
      if (!detail?.id) return;
      setCart((current) => {
        const index = current.findIndex((line) => line.id === detail.id);
        if (index >= 0) {
          const clone = [...current];
          clone[index] = { ...clone[index], qty: clone[index].qty + 1 };
          return clone;
        }
        return [...current, { id: detail.id, qty: 1, price_cents: guessPrice(detail.id) }];
      });
    };

    const handleClose = () => setOverlay(null);

    window.addEventListener("add-to-cart", handleAdd as EventListener);
    window.addEventListener("close-overlay", handleClose);

    return () => {
      window.removeEventListener("add-to-cart", handleAdd as EventListener);
      window.removeEventListener("close-overlay", handleClose);
    };
  }, []);

  const handleUtterance = useCallback(
    async (utterance: string) => {
      if (!session) return;
      try {
        setError(null);
        const response = await brainRespond(utterance, cart);
        if (response.response) {
          await speak(session.sessionId, response.response);
        }

        if (response.type === "show_products") {
          setOverlay({ type: "products", data: response.products });
        } else if (response.type === "directions") {
          setOverlay({ type: "directions", data: response.directions });
        } else if (response.type === "add_to_cart") {
          setCart(response.cart);
          setOverlay({ type: "chat", data: response.response || "Added to your cart." });
        } else if (response.type === "checkout") {
          setOverlay({ type: "chat", data: response.response || "Here is your total." });
        } else if (response.type === "chat") {
          setOverlay(response.response ? { type: "chat", data: response.response } : null);
        }
      } catch (err: any) {
        console.error("brain error", err);
        setError(err?.message || "Something went wrong");
        await speak(session.sessionId, "I’m sorry — something went wrong. Please try again.").catch(() => undefined);
      }
    },
    [session, cart]
  );

  const startSession = useCallback(async () => {
    try {
      const details = await newSession(avatarId);
      setSession(details);
      setStarted(true);
      setError(null);
      setTimeout(() => {
        speak(details.sessionId, "Hi! Welcome to Scoop Haven. How can I help you today?").catch(() => undefined);
      }, 600);
    } catch (err: any) {
      console.error("session start error", err);
      setError(err?.message || "Session failed");
      alert("Session could not start. Please verify your avatar configuration.");
    }
  }, [avatarId]);

  return (
    <div className="kiosk">
      {!started && <Hero onStart={startSession} />}
      {started && !session && (
        <div className="kiosk__loading">
          <p>Connecting to HeyGen…</p>
        </div>
      )}
      {session && (
        <>
          <AvatarStream session={session} avatarId={avatarId} onReady={() => undefined} />
          <OverlayManager overlay={overlay} />
          <div className="kiosk__mic">
            <MicBar onUtterance={handleUtterance} />
            {error && <p className="kiosk__error">{error}</p>}
          </div>
        </>
      )}
    </div>
  );
}

function guessPrice(productId: string) {
  switch (productId) {
    case "p1":
      return 12000;
    case "p2":
      return 9000;
    case "p3":
      return 18000;
    default:
      return 10000;
  }
}
