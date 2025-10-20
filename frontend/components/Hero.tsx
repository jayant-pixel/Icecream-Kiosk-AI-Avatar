"use client";

import type { FC } from "react";

interface HeroProps {
  onStart: () => void;
}

export const Hero: FC<HeroProps> = ({ onStart }) => (
  <section className="hero">
    <div className="hero__grid">
      <div className="hero__card">
        <span className="hero__eyebrow">Scoop Haven Kiosk</span>
        <h1 className="hero__heading">Delight guests with an AI scoop specialist</h1>
        <p className="hero__body">
          Launch a live conversation with our interactive avatar to guide visitors through flavours,
          recommendations, and checkout in real time.
        </p>
        <button type="button" className="button button--primary hero__cta" onClick={onStart}>
          Start Session
        </button>
      </div>

      <div className="hero__highlights">
        <div>
          <h2>What to expect</h2>
          <ul>
            <li>Instant avatar connection with HeyGen streaming</li>
            <li>Push-to-talk transcription via Whisper</li>
            <li>Smart product suggestions powered by OpenAI tools</li>
          </ul>
        </div>
        <div>
          <h2>Quick tip</h2>
          <p>
            Have your HeyGen streaming avatar ID and API key ready before starting the session. The
            avatar audio will be unmuted after you press start.
          </p>
        </div>
      </div>
    </div>
  </section>
);
