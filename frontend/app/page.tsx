"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function Home() {
  const router = useRouter();
  const [isNavigating, setIsNavigating] = useState(false);

  const handleStart = () => {
    if (isNavigating) return;
    setIsNavigating(true);
    router.push("/session");
  };

  return (
    <main className="landing" aria-labelledby="landing-heading">
      <div className="landing__panel">
        <div className="landing__copy">
          <h1 id="landing-heading" className="landing__heading">
            Discover Your Perfect Scoop
          </h1>
          <p className="landing__body">
            Launch a LiveKit session with our Anam avatar concierge. Explore flavours, build your
            cart, and get instant pickup directions.
          </p>
        </div>

        <div className="landing__cta">
          <button
            type="button"
            className="landing__button"
            onClick={handleStart}
            disabled={isNavigating}
          >
            {isNavigating ? "Starting…" : "Start"}
          </button>
          <span className="landing__status" role="status" aria-live="polite">
            {isNavigating ? "Fetching a LiveKit token…" : "Tap start when you’re ready."}
          </span>
        </div>
      </div>
    </main>
  );
}
