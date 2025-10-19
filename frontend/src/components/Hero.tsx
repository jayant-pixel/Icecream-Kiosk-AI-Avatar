import React from "react";

type HeroProps = {
  onStart: () => void;
};

export function Hero({ onStart }: HeroProps) {
  return (
    <div className="hero">
      <h1 className="hero__title">Scoop Haven Virtual Concierge</h1>
      <p className="hero__subtitle">
        Meet our AI avatar to explore ice-cream flavors, add scoops to your cart, and get directions to the freezer.
        Tap start to launch the live experience.
      </p>
      <button onClick={onStart} className="hero__start">
        Start
      </button>
    </div>
  );
}
