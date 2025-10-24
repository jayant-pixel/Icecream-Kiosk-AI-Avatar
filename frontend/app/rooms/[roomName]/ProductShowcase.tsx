"use client";

import { useEffect, useMemo, useState } from "react";
import { useRoomContext, useVoiceAssistant } from "@livekit/components-react";
import clsx from "clsx";

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

type ProductShowcaseProps = {
  className?: string;
};

export function ProductShowcase({ className }: ProductShowcaseProps = {}) {
  const room = useRoomContext();
  const { agent } = useVoiceAssistant();

  const [mode, setMode] = useState<"menu" | "detail" | "added" | null>(null);
  const [cards, setCards] = useState<ProductCard[]>([]);
  const [query, setQuery] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProductCard | null>(null);
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [directions, setDirections] = useState<DirectionsPayload | null>(null);
  const [pendingProductId, setPendingProductId] = useState<string | null>(null);
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
            setPendingProductId(null);
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
            setPendingProductId(null);
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
              setPendingProductId(null);
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
            setPendingProductId(null);
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
      setDetail(null);
      setSummary(null);
      setMenuTimestamp(null);
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
    const controllerIdentity =
      agent.attributes?.["agentControllerIdentity"] ?? agent.attributes?.["agentcontrolleridentity"];
    const destinationIdentity = controllerIdentity ?? agent.identity;
    if (!destinationIdentity) {
      console.warn("No destination identity available for add-to-cart RPC");
      return;
    }
    const productKey = String(productId);
    setPendingProductId(productKey);
    try {
      await room.localParticipant.performRpc({
        destinationIdentity,
        method: "agent.addToCart",
        payload: JSON.stringify({ productId, qty: 1 }),
      });
    } catch (error) {
      setPendingProductId(null);
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
  const primaryCardKey = primaryCard
    ? String(primaryCard.productId ?? primaryCard.id ?? primaryCard.name ?? "")
    : null;
  const isPendingPrimary = primaryCardKey ? pendingProductId === primaryCardKey : false;
  const primaryLabels = primaryCard ? normalizeDisplayNames(primaryCard.displayName) : [];

  const resolveSummaryValue = (key: "subtotalCents" | "taxCents" | "totalCents") => {
    const value = summary?.[key];
    return typeof value === "number" ? formatPrice(value) : "—";
  };

  const summaryMessage = typeof summary?.["message"] === "string" ? (summary?.["message"] as string) : null;

  const card = visible ? (
    <div className={clsx("pointer-events-auto w-full max-w-sm", className)}>
      <div className="rounded-[28px] border border-white/40 bg-white/95 p-6 shadow-2xl backdrop-blur-xl text-[color:var(--icecream-dark)]">
        {mode === "menu" ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--icecream-primary)]">
                Scoop&apos;s Signature Treats
              </p>
              <p className="text-sm text-black/60">
                {query
                  ? `Here are options for "${query}".`
                  : "Ask Scoop to highlight a flavour for more details."}
              </p>
            </div>
            <div className="flex flex-col gap-4">
              {menuCards.map((item) => (
                <article
                  key={item.id ?? item.productId ?? item.name}
                  className="flex items-center gap-3 rounded-2xl bg-white/85 p-3 shadow-sm"
                >
                  {item.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.imageUrl}
                      alt={item.name ?? "Menu item"}
                      className="h-24 w-24 rounded-2xl object-cover"
                    />
                  ) : (
                    <div className="flex h-24 w-24 items-center justify-center rounded-2xl bg-[color:var(--icecream-primary)]/10 text-sm font-semibold text-[color:var(--icecream-primary)]">
                      Scoop
                    </div>
                  )}
                  <h4 className="text-base font-semibold text-[color:var(--icecream-dark)]">
                    {item.name ?? "Treat"}
                  </h4>
                </article>
              ))}
            </div>
          </div>
        ) : null}

        {mode === "detail" && primaryCard ? (
          <div className="space-y-4">
            {primaryCard.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={primaryCard.imageUrl}
                alt={primaryCard.name ?? "Menu item"}
                className="h-56 w-full rounded-2xl object-cover"
              />
            ) : null}
            <div className="space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--icecream-primary)]">
                    Scoop recommends
                  </p>
                  <h3 className="text-xl font-semibold text-[color:var(--icecream-dark)]">
                    {primaryCard.name ?? "Treat"}
                  </h3>
                </div>
                <span className="text-lg font-semibold text-[color:var(--icecream-primary)]">
                  {formatPrice(primaryCard.priceCents, primaryCard.priceDollars)}
                </span>
              </div>
              {primaryCard.description ? (
                <p className="text-sm leading-relaxed text-black/70">{primaryCard.description}</p>
              ) : null}
              {primaryLabels.length > 0 ? (
                <div className="flex flex-wrap gap-2 text-xs text-black/60">
                  {primaryLabels.map((label) => {
                    const key = `${primaryCard.id ?? primaryCard.productId ?? primaryCard.name ?? "treat"}-${label}`;
                    return (
                      <span key={key} className="rounded-full bg-black/5 px-2 py-1">
                        {label}
                      </span>
                    );
                  })}
                </div>
              ) : null}
              <button
                type="button"
                disabled={!agent || isPendingPrimary}
                onClick={() => handleAddToCartClick(primaryCard)}
                className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-full bg-[color:var(--icecream-primary)] px-4 py-3 text-sm font-semibold text-white shadow-lg transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isPendingPrimary ? "Adding..." : "Add to cart"}
              </button>
              {!agent ? (
                <p className="text-xs text-center text-black/50">Scoop is getting ready to respond.</p>
              ) : null}
              {agent && isPendingPrimary ? (
                <p className="text-xs text-center text-[color:var(--icecream-primary)]/80">
                  Letting Scoop know about your pick...
                </p>
              ) : null}
            </div>
          </div>
        ) : null}

        {mode === "added" && primaryCard ? (
          <div className="space-y-4">
            {primaryCard.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={primaryCard.imageUrl}
                alt={primaryCard.name ?? "Menu item"}
                className="h-52 w-full rounded-2xl object-cover"
              />
            ) : null}
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--icecream-primary)]">
                Added to your tray
              </p>
              <h3 className="text-xl font-semibold text-[color:var(--icecream-dark)]">
                {primaryCard.name ?? "Treat"}
              </h3>
              <p className="text-sm text-black/70">Scoop is keeping it chilled while you finish up.</p>
            </div>
            <div className="rounded-2xl bg-black/5 p-4 text-sm text-black/70">
              <div className="flex justify-between">
                <span>Subtotal</span>
                <span>{resolveSummaryValue("subtotalCents")}</span>
              </div>
              <div className="flex justify-between">
                <span>Tax</span>
                <span>{resolveSummaryValue("taxCents")}</span>
              </div>
              <div className="mt-2 flex justify-between text-base font-semibold text-[color:var(--icecream-dark)]">
                <span>Total</span>
                <span>{resolveSummaryValue("totalCents")}</span>
              </div>
              {summaryMessage ? (
                <p className="mt-2 text-xs uppercase tracking-wide text-[color:var(--icecream-primary)]">
                  {summaryMessage}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-[color:var(--icecream-dark)] px-4 py-3 text-sm font-semibold text-white shadow-lg transition hover:brightness-105"
            >
              Pay at the Counter
            </button>
          </div>
        ) : null}
      </div>
    </div>
  ) : null;

  return (
    <>
      {card}

      {directions && directions.action === "show" ? (
        <div className="pointer-events-none fixed bottom-24 left-1/2 z-30 w-full max-w-sm -translate-x-1/2 px-4 sm:left-auto sm:right-6 sm:translate-x-0">
          <div className="pointer-events-auto rounded-[28px] border border-white/40 bg-white/95 p-5 shadow-2xl backdrop-blur-md text-[color:var(--icecream-dark)]">
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
                className="mt-3 h-56 w-full rounded-xl object-cover"
              />
            ) : null}
            {directions.directions?.[0]?.hint ? (
              <p className="mt-3 text-sm text-black/70">{directions.directions[0].hint}</p>
            ) : null}
          </div>
        </div>
      ) : null}

      {toast ? (
        <div className="pointer-events-none fixed bottom-10 left-1/2 z-40 w-full max-w-xs -translate-x-1/2 px-4 sm:left-auto sm:right-6 sm:translate-x-0">
          <div className="flex items-center gap-3 rounded-2xl bg-[color:var(--icecream-primary)] px-4 py-3 text-white shadow-xl">
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
