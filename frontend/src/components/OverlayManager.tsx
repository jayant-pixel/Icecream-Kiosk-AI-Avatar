import React from "react";
import { ProductOverlay } from "./ProductOverlay";
import { DirectionsOverlay } from "./DirectionsOverlay";
import type { DirectionsPayload, ProductSummary } from "../lib/api";

type ProductOverlayState = { type: "products"; data: ProductSummary[] };
type DirectionsOverlayState = { type: "directions"; data: DirectionsPayload };
type ChatOverlayState = { type: "chat"; data: string };

export type Overlay = ProductOverlayState | DirectionsOverlayState | ChatOverlayState | null;

type OverlayManagerProps = {
  overlay: Overlay;
};

export function OverlayManager({ overlay }: OverlayManagerProps) {
  if (!overlay) {
    return null;
  }

  return (
    <div className="overlay">
      {overlay.type === "products" && <ProductOverlay products={overlay.data} />}
      {overlay.type === "directions" && <DirectionsOverlay directions={overlay.data} />}
      {overlay.type === "chat" && <p className="overlay__chat">{overlay.data}</p>}
    </div>
  );
}
