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
  const [instructionsOpen, setInstructionsOpen] = useState(false);

  const handleStart = () => {
    if (loading) return;
    setError(null);
    setInstructionsOpen(true);
  };

  const handleEnterSession = () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    router.push(`/rooms/${encodeURIComponent(DEFAULT_ROOM)}?lang=${language}`);
  };

  return (
    <main className="icecream-hero" suppressHydrationWarning>
      <div className="max-w-3xl space-y-4" suppressHydrationWarning>
        <h1 className="text-4xl font-extrabold leading-tight drop-shadow-lg md:text-6xl">
          Meet Your Personal Ice Cream Concierge!
        </h1>
        <p className="text-lg text-white/80 md:text-xl">
          Discover your perfect scoop with Scoop, your AI tasting guide.
        </p>
      </div>

      <div className="mt-8 flex items-center gap-3" suppressHydrationWarning>
        <span className="text-sm font-medium text-white/70">Language:</span>
        <div className="flex overflow-hidden rounded-xl border border-white/20 shadow-lg">
          <button
            type="button"
            onClick={() => setLanguage("english")}
            className={`px-5 py-2.5 text-sm font-semibold transition-all duration-200 ${
              language === "english"
                ? "bg-[color:var(--icecream-primary)] text-white shadow-inner"
                : "bg-white/10 text-white/70 hover:bg-white/20"
            }`}
          >
            English
          </button>
          <button
            type="button"
            onClick={() => setLanguage("arabic")}
            className={`px-5 py-2.5 text-sm font-semibold transition-all duration-200 ${
              language === "arabic"
                ? "bg-[color:var(--icecream-primary)] text-white shadow-inner"
                : "bg-white/10 text-white/70 hover:bg-white/20"
            }`}
          >
            العربية
          </button>
        </div>
      </div>

      <div
        className="mt-6 flex flex-col items-center gap-4"
        suppressHydrationWarning
      >
        <button
          type="button"
          onClick={handleStart}
          disabled={loading}
          className="h-14 rounded-xl bg-[color:var(--icecream-primary)] px-8 font-semibold text-white shadow-lg transition-transform duration-200 hover:scale-105 disabled:opacity-70 disabled:hover:scale-100"
        >
          {loading
            ? language === "arabic"
              ? "جارٍ إدخال الجلسة..."
              : "Entering session..."
            : language === "arabic"
              ? "ابدأ"
              : "Start"}
        </button>
        {error ? (
          <p className="max-w-md text-center text-sm text-red-200">{error}</p>
        ) : (
          <p className="text-sm text-white/70">
            {language === "arabic"
              ? "ابدأ أولاً، راجع التعليمات، ثم ادخل الجلسة من النافذة المنبثقة."
              : "Start first, review the instructions, then enter the session from the popup."}
          </p>
        )}
      </div>

      {instructionsOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4 py-6">
          <div className="relative w-full max-w-4xl overflow-hidden rounded-[30px] border border-white/40 bg-[#dbe7ff] text-black shadow-[0_32px_90px_rgba(0,0,0,0.28)]">
            <button
              type="button"
              onClick={() => setInstructionsOpen(false)}
              disabled={loading}
              aria-label="Close"
              className="absolute right-5 top-5 inline-flex h-10 w-10 items-center justify-center rounded-full border border-black/10 bg-white/85 text-lg font-semibold text-black transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              X
            </button>

            <div className="max-h-[85vh] overflow-y-auto px-6 py-7 sm:px-8 sm:py-8">
              <div className="space-y-6">
                <div className="max-w-3xl space-y-3 pr-12">
                  <p className="text-sm font-semibold uppercase tracking-[0.22em] text-[#d13b8b]">
                    Pre-Session Brief
                  </p>
                  <h2 className="text-3xl font-extrabold leading-tight sm:text-4xl">
                    Galadari B&amp;R Conversational AI (POC)
                  </h2>
                  <p className="text-base leading-7 text-black/70 sm:text-lg">
                    Please review these guidelines before entering the session.
                    This proof of concept is optimized for a focused ordering
                    flow and controlled testing.
                  </p>
                </div>

                <div className="grid gap-4">
                  <section className="rounded-[24px] border border-black/10 bg-white/65 p-5 shadow-[0_10px_30px_rgba(62,78,118,0.08)] sm:p-6">
                    <div className="space-y-4">
                      <div>
                        <p className="text-xs font-bold uppercase tracking-[0.22em] text-[#d13b8b]">
                          Section I
                        </p>
                        <h3 className="mt-2 text-2xl font-bold">
                          Current Scope &amp; Capabilities
                        </h3>
                      </div>
                      <ul className="space-y-3 text-base leading-7 text-black/80">
                        <li className="flex items-start gap-3">
                          <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-[#d13b8b]" />
                          <span>
                            <span className="font-semibold">
                              Coverage scope:
                            </span>{" "}
                            Optimized only for{" "}
                            <span className="font-semibold">
                              Cups, Sundaes, and Milkshakes
                            </span>
                            .
                          </span>
                        </li>
                        <li className="flex items-start gap-3">
                          <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-[#d13b8b]" />
                          <span>
                            <span className="font-semibold">
                              Customization:
                            </span>{" "}
                            Dialogue flows are fully adaptable to Galadari brand
                            voice.
                          </span>
                        </li>
                        <li className="flex items-start gap-3">
                          <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-[#d13b8b]" />
                          <span>
                            <span className="font-semibold">Roadmap:</span>{" "}
                            Future phases will include training on historical
                            smart marketing data.
                          </span>
                        </li>
                      </ul>
                    </div>
                  </section>

                  <section className="rounded-[24px] border border-black/10 bg-white/65 p-5 shadow-[0_10px_30px_rgba(62,78,118,0.08)] sm:p-6">
                    <div className="space-y-4">
                      <div>
                        <p className="text-xs font-bold uppercase tracking-[0.22em] text-[#d13b8b]">
                          Section II
                        </p>
                        <h3 className="mt-2 text-2xl font-bold">
                          Operational Guidelines{" "}
                          <span className="text-[#9b1c1c]">(Dos)</span>
                        </h3>
                      </div>
                      <ul className="space-y-3 text-base leading-7 text-black/80">
                        <li className="flex items-start gap-3">
                          <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-[#d13b8b]" />
                          <span>
                            <span className="font-semibold">Language:</span>{" "}
                            Supports{" "}
                            <span className="font-semibold">
                              English and Arabic
                            </span>{" "}
                            (selectable via interface).
                          </span>
                        </li>
                        <li className="flex items-start gap-3">
                          <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-[#d13b8b]" />
                          <span>
                            <span className="font-semibold">Access:</span>{" "}
                            Limited to{" "}
                            <span className="font-semibold">
                              one user per session
                            </span>{" "}
                            via the provided link.
                          </span>
                        </li>
                        <li className="flex items-start gap-3">
                          <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-[#d13b8b]" />
                          <span>
                            <span className="font-semibold">Performance:</span>{" "}
                            Minor latency is expected on the POC test server;
                            production will be hosted on{" "}
                            <span className="font-semibold">
                              high-performance, scalable servers
                            </span>
                            .
                          </span>
                        </li>
                      </ul>
                    </div>
                  </section>

                  <section className="rounded-[24px] border border-black/10 bg-white/65 p-5 shadow-[0_10px_30px_rgba(62,78,118,0.08)] sm:p-6">
                    <div className="space-y-4">
                      <div>
                        <p className="text-xs font-bold uppercase tracking-[0.22em] text-[#d13b8b]">
                          Section III
                        </p>
                        <h3 className="mt-2 text-2xl font-bold">
                          Testing Constraints{" "}
                          <span className="text-[#9b1c1c]">
                            (Don&apos;ts)
                          </span>
                        </h3>
                      </div>
                      <ul className="space-y-3 text-base leading-7 text-black/80">
                        <li className="flex items-start gap-3">
                          <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-[#d13b8b]" />
                          <span>
                            <span className="font-semibold">
                              Scenario Focus:
                            </span>{" "}
                            Designed for{" "}
                            <span className="font-semibold">
                              positive user flows
                            </span>
                            ; do not test for extreme edge cases or negative
                            scenarios at this stage.
                          </span>
                        </li>
                        <li className="flex items-start gap-3">
                          <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-[#d13b8b]" />
                          <span>
                            <span className="font-semibold">
                              Session Limit:
                            </span>{" "}
                            Interactions are capped at{" "}
                            <span className="font-semibold">5 minutes</span>.
                            Sessions will auto-reset after this limit to ensure
                            stability.
                          </span>
                        </li>
                      </ul>
                    </div>
                  </section>
                </div>
              </div>
            </div>

            <div className="flex justify-center border-t border-black/10 bg-white/35 px-6 py-5 sm:px-8">
              <button
                type="button"
                onClick={handleEnterSession}
                disabled={loading}
                className="inline-flex min-w-[220px] items-center justify-center rounded-2xl bg-[color:var(--icecream-primary)] px-8 py-3.5 text-base font-semibold text-white shadow-lg transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-70"
              >
                {loading
                  ? language === "arabic"
                    ? "جارٍ إدخال الجلسة..."
                    : "Entering session..."
                  : language === "arabic"
                    ? "ادخل الجلسة"
                    : "Enter the Session"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
