"use client";

interface LandingProps {
  onStart: () => void;
  processing: boolean;
  status: string;
}

export const Landing = ({ onStart, processing, status }: LandingProps) => (
  <section className="landing" aria-labelledby="landing-heading">
    <div className="landing__panel">
      <div className="landing__copy">
        <h1 id="landing-heading" className="landing__heading">
          Discover Your Perfect Scoop!
        </h1>
        <p className="landing__body">
          Chat with our friendly AI avatar to get personalized ice cream recommendations and learn
          fun facts about our delicious flavors.
        </p>
      </div>

      <div className="landing__cta">
        <button
          type="button"
          className="landing__button"
          onClick={onStart}
          disabled={processing}
        >
          {processing ? "Connecting..." : "Talk to AI"}
        </button>
        <span className="landing__status" role="status" aria-live="polite">
          {status}
        </span>
      </div>
    </div>
  </section>
);
