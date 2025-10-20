"use client";

import type { FC } from "react";

interface DirectionsOverlayProps {
  directions: {
    displayName: string;
    hint?: string;
    mapImage?: string;
    steps?: string[];
  };
  onClose: () => void;
}

export const DirectionsOverlay: FC<DirectionsOverlayProps> = ({ directions, onClose }) => (
  <div className="overlay overlay--directions">
    <div className="overlay__header">
      <h2>Pickup directions</h2>
      <button type="button" className="overlay__close" onClick={onClose} aria-label="Close overlay">
        x
      </button>
    </div>
    <div className="overlay__content overlay__content--columns">
      <section className="directions-panel">
        <h3>{directions.displayName}</h3>
        {directions.hint && <p className="directions-panel__hint">{directions.hint}</p>}
        {directions.steps && directions.steps.length > 0 && (
          <ol>
            {directions.steps.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ol>
        )}
      </section>
      <figure className="map-panel">
        <img
          src={
            directions.mapImage ??
            "https://dummyimage.com/480x320/f5f3ff/4b3cc4&text=Display+Location"
          }
          alt={`${directions.displayName} map`}
          loading="lazy"
        />
      </figure>
    </div>
  </div>
);
