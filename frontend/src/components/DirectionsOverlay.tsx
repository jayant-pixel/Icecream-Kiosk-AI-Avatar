import type { FC } from "react";

interface DirectionsOverlayProps {
  directions: {
    displayName: string;
    steps: string[];
    bin: string;
    mapSvgUrl?: string;
  };
  onClose: () => void;
}

export const DirectionsOverlay: FC<DirectionsOverlayProps> = ({ directions, onClose }) => (
  <div className="overlay overlay--directions">
    <div className="overlay__header">
      <h2>Pickup directions</h2>
      <button type="button" className="overlay__close" onClick={onClose} aria-label="Close overlay">
        ✕
      </button>
    </div>
    <div className="overlay__content overlay__content--columns">
      <section className="directions-panel">
        <h3>{directions.displayName}</h3>
        <ol>
          {directions.steps.map((step, index) => (
            <li key={index}>{step}</li>
          ))}
        </ol>
        <p className="directions-panel__bin">Bin code: {directions.bin}</p>
      </section>
      <figure className="map-panel">
        <img
          src={directions.mapSvgUrl ?? "https://dummyimage.com/480x320/f5f3ff/4b3cc4&text=Store+Map"}
          alt="Store map"
          loading="lazy"
        />
      </figure>
    </div>
  </div>
);
