"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const DEFAULT_ROOM =
  process.env.NEXT_PUBLIC_LIVEKIT_ROOM?.trim() || "kiosk-room";

export default function Page() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleStart = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/livekit/request-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: DEFAULT_ROOM }),
      });

      if (!response.ok) {
        const { error: message } = await response.json().catch(() => ({
          error: "Failed to request Scoop avatar",
        }));
        throw new Error(message);
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unable to start the session";
      setError(message);
      setLoading(false);
      return;
    }

    router.push(`/rooms/${encodeURIComponent(DEFAULT_ROOM)}`);
  };

  return (
    <main className="icecream-hero">
      <div className="space-y-4 max-w-3xl">
        <h1 className="text-4xl md:text-6xl font-extrabold leading-tight drop-shadow-lg">
          Meet Your Personal Ice Cream Concierge!
        </h1>
        <p className="text-lg md:text-xl text-white/80">
          Discover your perfect scoop with Scoop, your AI tasting guide.
        </p>
      </div>
      <div className="mt-10 flex flex-col items-center gap-4">
        <button
          type="button"
          onClick={handleStart}
          disabled={loading}
          className="h-14 px-8 rounded-xl bg-[color:var(--icecream-primary)] text-white font-semibold shadow-lg transition-transform duration-200 hover:scale-105 disabled:opacity-70 disabled:hover:scale-100"
        >
          {loading ? "Preparing your room..." : "Let’s Get Started!"}
        </button>
        {error ? (
          <p className="text-sm text-red-200 max-w-md text-center">{error}</p>
        ) : (
          <p className="text-sm text-white/70">
            We’ll invite Scoop automatically and jump right into the room.
          </p>
        )}
      </div>
    </main>
  );
}
