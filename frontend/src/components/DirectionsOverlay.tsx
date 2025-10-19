import React from "react";
import type { DirectionsPayload } from "../lib/api";

type DirectionsOverlayProps = {
  directions: DirectionsPayload;
};

export function DirectionsOverlay({ directions }: DirectionsOverlayProps) {
  return (
    <div className="overlay-card">
      <h2>Pickup directions</h2>
      <p className="directions__title">{directions.display_name}</p>
      <ol className="directions__steps">
        {directions.steps.map((step, index) => (
          <li key={index}>{step}</li>
        ))}
      </ol>
      {directions.map_svg_url && (
        <img src={directions.map_svg_url} alt="Store map" className="directions__map" />
      )}
      <button className="overlay-card__close" onClick={() => window.dispatchEvent(new Event("close-overlay"))}>
        Close
      </button>
    </div>
  );
}
