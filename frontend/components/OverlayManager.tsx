"use client";

import type { FC } from "react";

import type { Product } from "@/lib/types";

import { DirectionsOverlay } from "./DirectionsOverlay";
import { ProductOverlay } from "./ProductOverlay";

export type Overlay =
  | { type: "products"; products: Product[] }
  | {
      type: "directions";
      directions: {
        displayName: string;
        hint?: string;
        mapImage?: string;
        steps?: string[];
      };
    };

interface OverlayManagerProps {
  overlay: Overlay | null;
  onAddToCart: (productId: string) => Promise<void> | void;
  onClose: () => void;
}

export const OverlayManager: FC<OverlayManagerProps> = ({ overlay, onAddToCart, onClose }) => {
  if (!overlay) {
    return null;
  }

  if (overlay.type === "products") {
    return <ProductOverlay products={overlay.products} onAddToCart={onAddToCart} onClose={onClose} />;
  }

  return <DirectionsOverlay directions={overlay.directions} onClose={onClose} />;
};
