"use client";

import { useEffect, useMemo, useState } from "react";
import { RoomEvent } from "livekit-client";
import { useRoomContext, useVoiceAssistant } from "@livekit/components-react";
import clsx from "clsx";

type Product = {
  id?: string;
  name?: string;
  description?: string;
  priceDollars?: number;
  imageUrl?: string;
  displayName?: string[] | string;
};

type Direction = {
  displayName?: string;
  mapImage?: string;
  hint?: string;
};

type CartItem = {
  productId?: string;
  name?: string;
  qty?: number;
  priceDollars?: number;
  imageUrl?: string;
};

type CartSummary = {
  subtotalDollars?: number;
  taxDollars?: number;
  totalDollars?: number;
  message?: string;
};

type OverlayPayload =
  | { kind: "products"; products?: Product[]; query?: string | null }
  | { kind: "directions"; directions?: Direction[]; fallback?: string }
  | { kind: "cart"; items?: CartItem[]; summary?: CartSummary }
  | { kind: string; [key: string]: unknown };

const decoder = new TextDecoder();

export function OverlayLayer() {
  const room = useRoomContext();
  const [overlay, setOverlay] = useState<OverlayPayload | null>(null);

  useEffect(() => {
    if (!room) return;

    const handleData = (payload: Uint8Array) => {
      try {
        const json = JSON.parse(decoder.decode(payload));
        if (json?.type === "ui.overlay" && json.payload) {
          setOverlay(json.payload as OverlayPayload);
        }
      } catch (error) {
        console.warn("Ignoring malformed overlay payload", error);
      }
    };

    room.on(RoomEvent.DataReceived, handleData);
    return () => {
      room.off(RoomEvent.DataReceived, handleData);
    };
  }, [room]);

  const content = useMemo(() => {
    if (!overlay) return null;
    switch (overlay.kind) {
      case "products":
        return <ProductsOverlay payload={overlay} />;
      case "directions":
        return <DirectionsOverlay payload={overlay} />;
      case "cart":
        return <CartOverlay payload={overlay} />;
      default:
        return null;
    }
  }, [overlay]);

  if (!content) return null;

  return (
    <div className="pointer-events-auto w-full max-w-[min(90vw,900px)]">
      <div className="rounded-3xl bg-white/85 p-6 shadow-2xl backdrop-blur-md text-[color:var(--icecream-dark)]">
        <div className="flex items-start justify-between gap-6">
          <div className="flex-1 min-w-0">{content}</div>
          <button
            type="button"
            onClick={() => setOverlay(null)}
            className="ml-4 rounded-full bg-black/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-black/70 hover:bg-black/20"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function formatPrice(dollars?: number) {
  if (typeof dollars === "number") {
    return `$${dollars.toFixed(2)}`;
  }
  return "";
}

function ProductsOverlay({ payload }: { payload: OverlayPayload }) {
  const products = (payload as { products?: Product[] }).products ?? [];
  const query = (payload as { query?: string | null }).query;
  if (products.length === 0) {
    return <p className="text-sm opacity-70">No products available yet.</p>;
  }

  return (
    <div className="space-y-4">
      {query && (
        <p className="text-sm font-medium uppercase tracking-wide text-[color:var(--icecream-primary)]">
          Recommendations for: {query}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {products.map((product) => (
          <article
            key={product.id ?? product.name}
            className="flex gap-4 rounded-2xl bg-white/80 p-4 shadow-md"
          >
            {product.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={product.imageUrl}
                alt={product.name ?? "Product image"}
                className="h-28 w-28 rounded-xl object-cover"
              />
            ) : (
              <div className="flex h-28 w-28 items-center justify-center rounded-xl bg-[color:var(--icecream-primary)]/10 text-sm font-semibold text-[color:var(--icecream-primary)]">
                Scoop
              </div>
            )}
            <div className="space-y-1">
              <h3 className="text-base font-semibold">{product.name}</h3>
              <p className="text-sm opacity-75 line-clamp-3">{product.description}</p>
              <div className="flex flex-wrap gap-2 pt-1 text-xs uppercase tracking-wide">
                <span className="rounded-full bg-[color:var(--icecream-primary)]/10 px-2 py-1 font-semibold text-[color:var(--icecream-primary)]">
                  {formatPrice(product.priceDollars)}
                </span>
                {Array.isArray(product.displayName) &&
                  product.displayName.map((label) => (
                    <span key={`${product.id}-${label}`} className="rounded-full bg-black/5 px-2 py-1 text-black/60">
                      {label}
                    </span>
                  ))}
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function DirectionsOverlay({ payload }: { payload: OverlayPayload }) {
  const directions = (payload as { directions?: Direction[] }).directions ?? [];
  const fallback = (payload as { fallback?: string }).fallback;
  if (directions.length === 0) {
    return (
      <div className="space-y-2">
        <h3 className="text-lg font-semibold">Pickup guidance</h3>
        <p className="text-sm opacity-80">
          {fallback ? `We're fetching directions for ${fallback}â€¦` : "Directions will appear here shortly."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold text-[color:var(--icecream-primary)]">Pickup Guidance</h3>
      <div className="space-y-3">
        {directions.map((entry, index) => (
          <article
            key={`${entry.displayName ?? index}`}
            className="flex flex-col gap-3 rounded-2xl bg-white/80 p-4 shadow-sm sm:flex-row"
          >
            {entry.mapImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={entry.mapImage}
                alt={entry.displayName ?? "Map"}
                className="h-40 w-full rounded-xl object-cover sm:w-52"
              />
            ) : null}
            <div className="space-y-1">
              <h4 className="text-base font-semibold">{entry.displayName ?? "Display"}</h4>
              <p className="text-sm opacity-75">
                {entry.hint ?? "Look for the Scoop signage nearby."}
              </p>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function CartOverlay({ payload }: { payload: OverlayPayload }) {
  const items = (payload as { items?: CartItem[] }).items ?? [];
  const summary = (payload as { summary?: CartSummary }).summary ?? {};

  return (
    <div className="space-y-4">
      <h3 className="text-lg font-semibold text-[color:var(--icecream-primary)]">Cart snapshot</h3>
      {items.length === 0 ? (
        <p className="text-sm opacity-70">Your cart is currently empty.</p>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <div
              key={item.productId ?? item.name}
              className="flex items-center gap-3 rounded-2xl bg-white/80 p-3 shadow-sm"
            >
              {item.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={item.imageUrl}
                  alt={item.name ?? "Product"}
                  className="h-20 w-20 rounded-lg object-cover"
                />
              ) : (
                <div className="flex h-20 w-20 items-center justify-center rounded-lg bg-[color:var(--icecream-primary)]/10 text-[color:var(--icecream-primary)]">
                  {item.qty}Ã—
                </div>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold">{item.name}</p>
                <p className="text-xs opacity-70">Qty {item.qty} Ã— {formatPrice(item.priceDollars)}</p>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="rounded-2xl bg-black/5 p-4 text-sm">
        <div className="flex justify-between">
          <span>Subtotal</span>
          <span>{formatPrice(summary.subtotalDollars)}</span>
        </div>
        <div className="flex justify-between">
          <span>Tax</span>
          <span>{formatPrice(summary.taxDollars)}</span>
        </div>
        <div className="mt-2 flex justify-between text-base font-semibold">
          <span>Total</span>
          <span>{formatPrice(summary.totalDollars)}</span>
        </div>
        {summary.message && (
          <p className="mt-2 text-xs uppercase tracking-wide text-[color:var(--icecream-primary)]">
            {summary.message}
          </p>
        )}
      </div>
    </div>
  );
}
