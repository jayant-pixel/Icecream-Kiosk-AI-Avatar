"use client";

import type { FC } from "react";

import type { Product } from "@/lib/types";

interface ProductOverlayProps {
  products: Product[];
  onAddToCart: (productId: string) => Promise<void> | void;
  onClose: () => void;
}

const formatPrice = (priceCents: number) => `$${(priceCents / 100).toFixed(2)}`;

export const ProductOverlay: FC<ProductOverlayProps> = ({ products, onAddToCart, onClose }) => (
  <div className="overlay overlay--products">
    <div className="overlay__header">
      <h2>Popular picks for you</h2>
      <button type="button" className="overlay__close" onClick={onClose} aria-label="Close overlay">
        ×
      </button>
    </div>
    <div className="overlay__content overlay__content--grid">
      {products.map((product) => (
        <article key={product.id} className="product-card">
          <div className="product-card__media">
            <img
              src={product.imageUrl}
              alt={product.name}
              loading="lazy"
              onError={(event) => {
                const target = event.currentTarget;
                target.src = "https://dummyimage.com/320x320/ede9ff/4b3cc4&text=Sweet+Treat";
              }}
            />
          </div>
          <div className="product-card__body">
            <header className="product-card__header">
              <h3>{product.name}</h3>
              <p>{formatPrice(product.priceCents)}</p>
            </header>
            {product.description && <p className="product-card__description">{product.description}</p>}
            {product.displayNames.length > 0 && (
              <ul className="product-card__locations" aria-label="Display locations">
                {product.displayNames.map((location) => (
                  <li key={location}>{location}</li>
                ))}
              </ul>
            )}
            <button type="button" className="button button--primary" onClick={() => onAddToCart(product.id)}>
              Add to cart
            </button>
          </div>
        </article>
      ))}
    </div>
  </div>
);
