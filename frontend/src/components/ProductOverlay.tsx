import React from "react";
import type { ProductSummary } from "../lib/api";

type ProductOverlayProps = {
  products: ProductSummary[];
};

export function ProductOverlay({ products }: ProductOverlayProps) {
  if (!products.length) {
    return (
      <div className="overlay-card">
        <h2>No matches yet</h2>
        <p>Ask for a flavour and I will show what we have in stock.</p>
      </div>
    );
  }

  const handleAdd = (id: string) => {
    const event = new CustomEvent("add-to-cart", { detail: { id } });
    window.dispatchEvent(event);
  };

  return (
    <div className="overlay-card">
      <h2>Recommended treats</h2>
      <div className="overlay-card__grid">
        {products.map((product) => (
          <article key={product.id} className="product-card">
            <img
              src={product.image_url || "/img/placeholder.svg"}
              alt={product.name}
              className="product-card__image"
            />
            <div className="product-card__body">
              <h3>{product.name}</h3>
              <p className="product-card__price">₹{(product.price_cents / 100).toFixed(2)}</p>
              <button onClick={() => handleAdd(product.id)} className="product-card__cta">
                Add to cart
              </button>
            </div>
          </article>
        ))}
      </div>
      <button className="overlay-card__close" onClick={() => window.dispatchEvent(new Event("close-overlay"))}>
        Close
      </button>
    </div>
  );
}
