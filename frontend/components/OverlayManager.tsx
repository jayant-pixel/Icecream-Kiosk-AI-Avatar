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
        steps: string[];
        bin: string;
        mapSvgUrl?: string;
      };
    }
  | { type: "checkout"; receipt: { subtotal: number; tax: number; total: number } };

interface OverlayManagerProps {
  overlay: Overlay | null;
  onAddToCart: (productId: string) => Promise<void> | void;
  onClose: () => void;
}

const formatPrice = (value: number) => `$${(value / 100).toFixed(2)}`;

export const OverlayManager: FC<OverlayManagerProps> = ({ overlay, onAddToCart, onClose }) => {
  if (!overlay) {
    return null;
  }

  if (overlay.type === "products") {
    return <ProductOverlay products={overlay.products} onAddToCart={onAddToCart} onClose={onClose} />;
  }

  if (overlay.type === "directions") {
    return <DirectionsOverlay directions={overlay.directions} onClose={onClose} />;
  }

  return (
    <div className="overlay overlay--checkout">
      <div className="overlay__header">
        <h2>Order summary</h2>
        <button type="button" className="overlay__close" onClick={onClose} aria-label="Close overlay">
          ×
        </button>
      </div>
      <div className="overlay__content overlay__content--stack">
        <dl className="receipt">
          <div>
            <dt>Subtotal</dt>
            <dd>{formatPrice(overlay.receipt.subtotal)}</dd>
          </div>
          <div>
            <dt>Tax</dt>
            <dd>{formatPrice(overlay.receipt.tax)}</dd>
          </div>
          <div>
            <dt>Total</dt>
            <dd className="receipt__total">{formatPrice(overlay.receipt.total)}</dd>
          </div>
        </dl>
        <p className="receipt__hint">Show this total at checkout to complete your order.</p>
      </div>
    </div>
  );
};
