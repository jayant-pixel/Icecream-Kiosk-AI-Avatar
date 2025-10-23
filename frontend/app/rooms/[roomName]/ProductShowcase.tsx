"use client";

import { useEffect, useMemo, useState } from "react";
import { useRoomContext, useVoiceAssistant } from "@livekit/components-react";

type ProductCard = {
  id?: string;
  productId?: string;
  name?: string;
  description?: string;
  priceCents?: number | null;
  priceDollars?: number | null;
  imageUrl?: string | null;
  displayName?: string[] | string;
};

type ProductRpcPayload =
  | { action: "menu"; products: ProductCard[]; query?: string | null }
  | { action: "detail"; products: ProductCard[]; query?: string | null }
  | { action: "added"; product: ProductCard; qty?: number; summary?: Record<string, unknown> }
  | { action: "clear" };

type DirectionsPayload =
  | { action: "show"; display?: string; directions?: any[] }
  | { action: "clear"; display?: string };

type ToastState = {
  product: ProductCard;
  qty: number;
  expiresAt: number;
};

const formatPrice = (cents?: number | null, dollars?: number | null) => {
  if (typeof dollars === "number") {
    return `$${dollars.toFixed(2)}`;
  }
  if (typeof cents === "number") {
    return `$${(cents / 100).toFixed(2)}`;
  }
  return "";
};

const normalizeDisplayNames = (displayName?: string[] | string) => {
  if (!displayName) return [];
  if (Array.isArray(displayName)) {
    return displayName;
  }
  return [displayName];
};

const MENU_EXPIRES_MS = 7000;
const TOAST_DURATION_MS = 3200;

export function ProductShowcase() {
  const room = useRoomContext();
  const { agent } = useVoiceAssistant();

  const [mode, setMode] = useState<"menu" | "detail" | "added" | null>(null);
  const [cards, setCards] = useState<ProductCard[]>([]);
  const [query, setQuery] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProductCard | null>(null);
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [directions, setDirections] = useState<DirectionsPayload | null>(null);
  const [menuTimestamp, setMenuTimestamp] = useState<number | null>(null);

  useEffect(() => {
    if (!room) return;

    const handleProductRpc = async (data: any): Promise<string> => {
      try {
        const payloadRaw =
          typeof data?.payload === "string" ? data.payload : JSON.stringify(data?.payload ?? {});
        const payload = JSON.parse(payloadRaw) as ProductRpcPayload;

        switch (payload.action) {
          case "menu": {
            setMode("menu");
            setCards(payload.products ?? []);
            setQuery(payload.query ?? null);
            setDetail(null);
            setSummary(null);
            setMenuTimestamp(Date.now());
            break;
          }
          case "detail": {
            setMode("detail");
            const detailCard = payload.products?.[0] ?? null;
            setDetail(detailCard ?? null);
            setCards(payload.products ?? []);
            setQuery(payload.query ?? null);
            setSummary(null);
            setMenuTimestamp(null);
            break;
          }
          case "added": {
            if (payload.product) {
              setMode("added");
              setDetail(payload.product);
              setSummary(payload.summary ?? null);
              setCards([payload.product]);
              setToast({
                product: payload.product,
                qty: Math.max(1, payload.qty ?? 1),
                expiresAt: Date.now() + TOAST_DURATION_MS,
              });
            }
            setMenuTimestamp(null);
            break;
          }
          case "clear": {
            setMode(null);
            setCards([]);
            setQuery(null);
            setDetail(null);
            setSummary(null);
            setMenuTimestamp(null);
            break;
          }
          default:
            break;
        }
        return "ok";
      } catch (error) {
        console.error("Error handling product RPC", error);
        return "error";
      }
    };

    room.localParticipant.registerRpcMethod("client.products", handleProductRpc);
    return () => {
      room.localParticipant.unregisterRpcMethod("client.products");
    };
  }, [room]);

  useEffect(() => {
    if (!room) return;

    const handleDirectionsRpc = async (data: any): Promise<string> => {
      try {
        const payloadRaw =
          typeof data?.payload === "string" ? data.payload : JSON.stringify(data?.payload ?? {});
        const payload = JSON.parse(payloadRaw) as DirectionsPayload;

        switch (payload.action) {
          case "show":
            setDirections(payload);
            break;
          case "clear":
            setDirections(null);
            break;
          default:
            break;
        }
        return "ok";
      } catch (error) {
        console.error("Error handling directions RPC", error);
        return "error";
      }
    };

    room.localParticipant.registerRpcMethod("client.directions", handleDirectionsRpc);
    return () => {
      room.localParticipant.unregisterRpcMethod("client.directions");
    };
  }, [room]);

  useEffect(() => {
    if (!toast) return;
    const remaining = toast.expiresAt - Date.now();
    if (remaining <= 0) {
      setToast(null);
      return;
    }
    const timer = window.setTimeout(() => setToast(null), remaining);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (mode !== "menu" || !menuTimestamp) return;
    const timer = window.setTimeout(() => {
      setMode(null);
      setCards([]);
      setQuery(null);
    }, MENU_EXPIRES_MS);
    return () => window.clearTimeout(timer);
  }, [mode, menuTimestamp]);

  const visible = mode !== null && cards.length > 0;

  const handleAddToCartClick = async (card: ProductCard) => {
    if (!room || !agent) {
      console.warn("Agent not ready for add-to-cart RPC");
      return;
    }
    const productId = card.productId ?? card.id ?? card.name;
    if (!productId) {
      console.warn("Missing product identifier for add-to-cart RPC");
      return;
    }
    try {
      await room.localParticipant.performRpc({
        destinationIdentity: agent.identity,
        method: "agent.addToCart",
        payload: JSON.stringify({ productId, qty: 1 }),
      });
    } catch (error) {
      console.error("Failed to invoke add-to-cart RPC", error);
    }
  };

  const menuCards = useMemo(() => {
    if (mode !== "menu") {
      return cards;
    }
    return cards.map((card) => ({
      ...card,
      priceCents: null,
      priceDollars: null,
      description: undefined,
    }));
  }, [mode, cards]);

  const primaryCard = detail ?? cards[0] ?? null;

  return (
    <>
      {visible ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-[18rem] flex justify-center px-4">
          <div className="pointer-events-auto max-w-[min(90vw,900px)]">
            <div className="rounded-3xl bg-white/90 p-6 shadow-2xl backdrop-blur-md text-[color:var(--icecream-dark)]">
              {mode === "menu" ? (
                <>
                  <div className="mb-4 space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--icecream-primary)]">
                      Scoop&apos;s Signature Treats
                    </p>
                    <p className="text-sm text-black/60">
                      {query ? `Here are options for “${query}”.` : "Tap a card to ask Scoop about it."}
                    </p>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    {menuCards.map((card) => (
                      <article
                        key={card.id ?? card.productId ?? card.name}
                        className="flex flex-col items-center gap-3 rounded-2xl bg-white/85 p-4 shadow-md transition-transform duration-200 hover:-translate-y-1"
                      >
                        {card.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={card.imageUrl}
                            alt={card.name ?? "Menu item"}
                            className="h-40 w-full rounded-xl object-cover"
                          />
                        ) : null}
                        <h4 className="text-base font-semibold text-[color:var(--icecream-dark)] text-center">
                          {card.name ?? "Treat"}
                        </h4>
                      </article>
                    ))}
                  </div>
                </>
              ) : null}

              {mode === "detail" && primaryCard ? (
                <div className="flex flex-col gap-4">
                  <div className="flex flex-col gap-3 rounded-2xl bg-white/90 p-4 shadow-md sm:flex-row">
                    {primaryCard.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={primaryCard.imageUrl}
                        alt={primaryCard.name ?? "Menu item"}
                        className="h-44 w-full max-w-[230px] rounded-xl object-cover"
                      />
                    ) : null}
                    <div className="flex-1 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-xl font-semibold text-[color:var(--icecream-dark)]">
                          {primaryCard.name ?? "Treat"}
                        </h3>
                        <span className="text-lg font-semibold text-[color:var(--icecream-primary)]">
                          {formatPrice(primaryCard.priceCents, primaryCard.priceDollars)}
                        </span>
                      </div>
                      {primaryCard.description ? (
                        <p className="text-sm leading-relaxed text-black/70">{primaryCard.description}</p>
                      ) : null}
                      <div className="flex flex-wrap gap-2 text-xs text-black/60">
                        {normalizeDisplayNames(primaryCard.displayName).map((label) => (
                          <span key={`${primaryCard.id}-${label}`} className="rounded-full bg-black/5 px-2 py-1">
                            {label}
                          </span>
                        ))}
                      </div>
                      <div className="pt-2">
                        <button
                          type="button"
                          disabled={!agent}
                          onClick={() => handleAddToCartClick(primaryCard)}
                          className="inline-flex items-center gap-2 rounded-full bg-[color:var(--icecream-primary)] px-4 py-2 text-sm font-semibold text-white shadow-md transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
                        >
                          Add to cart
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ) : null}

              {mode === "added" && primaryCard ? (
                <div className="space-y-4">
                  <div className="flex flex-col gap-3 rounded-2xl bg-white/90 p-4 shadow-md sm:flex-row">
                    {primaryCard.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={primaryCard.imageUrl}
                        alt={primaryCard.name ?? "Menu item"}
                        className="h-36 w-full max-w-[210px] rounded-xl object-cover"
                      />
                    ) : null}
                    <div className="flex-1 space-y-1">
                      <h3 className="text-lg font-semibold text-[color:var(--icecream-dark)]">
                        {primaryCard.name ?? "Treat"}
                      </h3>
                      <p className="text-sm text-black/70">Added to your tray. Scoop will keep it chilled.</p>
                      <p className="text-sm font-semibold text-[color:var(--icecream-primary)]">
                        {formatPrice(primaryCard.priceCents, primaryCard.priceDollars)}
                      </p>
                    </div>
                  </div>
                  {summary ? (
                    <div className="rounded-2xl bg-black/5 p-4 text-sm text-black/70">
                      <div className="flex justify-between">
                        <span>Subtotal</span>
                        <span>{formatPrice(summary.subtotalCents as number)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span>Tax</span>
                        <span>{formatPrice(summary.taxCents as number)}</span>
                      </div>
                      <div className="mt-2 flex justify-between text-base font-semibold text-[color:var(--icecream-dark)]">
                        <span>Total</span>
                        <span>{formatPrice(summary.totalCents as number)}</span>
                      </div>
                      {summary.message ? (
                        <p className="mt-2 text-xs uppercase tracking-wide text-[color:var(--icecream-primary)]">
                          {summary.message as string}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {directions && directions.action === "show" ? (
        <div className="pointer-events-none fixed bottom-24 left-1/2 z-30 w-full max-w-md -translate-x-1/2 px-4">
          <div className="pointer-events-auto rounded-3xl bg-white/95 p-5 shadow-2xl backdrop-blur-md text-[color:var(--icecream-dark)]">
            <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--icecream-primary)]">
              Pickup Spot
            </p>
            <h3 className="text-lg font-semibold">
              {directions.display ?? directions.directions?.[0]?.displayName ?? "Pickup"}
            </h3>
            {directions.directions?.[0]?.mapImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={directions.directions[0].mapImage}
                alt={directions.display ?? "Directions"}
                className="mt-3 h-40 w-full rounded-xl object-cover"
              />
            ) : null}
            {directions.directions?.[0]?.hint ? (
              <p className="mt-3 text-sm text-black/70">{directions.directions[0].hint}</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {toast ? (
        <div className="pointer-events-none fixed bottom-10 left-1/2 z-40 w-full max-w-sm -translate-x-1/2 px-4">
          <div className="flex items-center gap-3 rounded-2xl bg-[color:var(--icecream-primary)] text-white px-4 py-3 shadow-xl">
            <div className="flex-1">
              <p className="text-sm font-semibold">
                Added {toast.qty} x {toast.product.name ?? "treat"}
              </p>
              <p className="text-xs opacity-80">
                {formatPrice(toast.product.priceCents ?? undefined, toast.product.priceDollars ?? undefined)}
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
