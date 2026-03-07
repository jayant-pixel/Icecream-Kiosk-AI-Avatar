"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const DEFAULT_ROOM =
  process.env.NEXT_PUBLIC_LIVEKIT_ROOM?.trim() || "kiosk-room";

type Language = "english" | "arabic";

export default function Page() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState<Language>("english");

  const handleStart = async () => {
    if (loading) return;
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/livekit/request-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ room: DEFAULT_ROOM, language }),
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

    router.push(
      `/rooms/${encodeURIComponent(DEFAULT_ROOM)}?lang=${language}`
    );
  };

  return (
    <main className="icecream-hero" suppressHydrationWarning>
      <div className="space-y-4 max-w-3xl" suppressHydrationWarning>
        <h1 className="text-4xl md:text-6xl font-extrabold leading-tight drop-shadow-lg">
          Meet Your Personal Ice Cream Concierge!
        </h1>
        <p className="text-lg md:text-xl text-white/80">
          Discover your perfect scoop with Scoop, your AI tasting guide.
        </p>
      </div>

      {/* Language Selector */}
      <div className="mt-8 flex items-center gap-3" suppressHydrationWarning>
        <span className="text-sm text-white/70 font-medium">Language:</span>
        <div className="flex rounded-xl overflow-hidden border border-white/20 shadow-lg">
          <button
            type="button"
            onClick={() => setLanguage("english")}
            className={`px-5 py-2.5 text-sm font-semibold transition-all duration-200 ${language === "english"
                ? "bg-[color:var(--icecream-primary)] text-white shadow-inner"
                : "bg-white/10 text-white/70 hover:bg-white/20"
              }`}
          >
            English
          </button>
          <button
            type="button"
            onClick={() => setLanguage("arabic")}
            className={`px-5 py-2.5 text-sm font-semibold transition-all duration-200 ${language === "arabic"
                ? "bg-[color:var(--icecream-primary)] text-white shadow-inner"
                : "bg-white/10 text-white/70 hover:bg-white/20"
              }`}
          >
            العربية
          </button>
        </div>
      </div>

      <div className="mt-6 flex flex-col items-center gap-4" suppressHydrationWarning>
        <button
          type="button"
          onClick={handleStart}
          disabled={loading}
          className="h-14 px-8 rounded-xl bg-[color:var(--icecream-primary)] text-white font-semibold shadow-lg transition-transform duration-200 hover:scale-105 disabled:opacity-70 disabled:hover:scale-100"
        >
          {loading
            ? language === "arabic"
              ? "جاري التحضير..."
              : "Preparing your room..."
            : language === "arabic"
              ? "يلا نبدأ!"
              : "Let's Get Started!"}
        </button>
        {error ? (
          <p className="text-sm text-red-200 max-w-md text-center">{error}</p>
        ) : (
          <p className="text-sm text-white/70">
            {language === "arabic"
              ? "بنستدعي Sarah تلقائياً وندخّلك الغرفة على طول."
              : "We'll invite Scoop automatically and jump right into the room."}
          </p>
        )}
      </div>
    </main>
  );
}
