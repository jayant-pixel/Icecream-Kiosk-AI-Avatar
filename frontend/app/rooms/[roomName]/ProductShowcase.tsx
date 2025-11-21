"use client";

import { useEffect, useMemo, useState } from "react";
import { useRoomContext, useVoiceAssistant } from "@livekit/components-react";
import clsx from "clsx";
import type { RpcInvocationData } from "livekit-client";

type ProductCard = {
  id?: string;
  productId?: string;
  name?: string;
  description?: string;
  priceAED?: number | null;
  imageUrl?: string | null;
  displayName?: string[] | string;
  category?: string | null;
};

type CartItemState = {
  key: string;
  card: ProductCard;
  qty: number;
};

type CategoryOption = {
  label: string;
  slug: string;
};

type ProductRpcPayload =
  | { action: "menu"; products: ProductCard[]; query?: string | null }
  | { action: "detail"; products: ProductCard[]; query?: string | null }
  | { action: "added"; product: ProductCard; qty?: number; summary?: Record<string, unknown> }
  | { action: "clear" };

export type DirectionEntry = {
  displayName?: string;
  hint?: string | null;
  mapImage?: string | null;
  products?: string[];
};

export type DirectionsPayload =
  | { action: "show"; display?: string; displayName?: string; directions?: DirectionEntry[] }
  | { action: "clear"; display?: string; displayName?: string };

type ToastState = {
  product: ProductCard;
  qty: number;
  expiresAt: number;
};

const formatPrice = ({
  aed,
  dollars,
  cents,
}: {
  aed?: number | null;
  dollars?: number | null;
  cents?: number | null;
} = {}) => {
  if (typeof aed === "number") {
    return `AED ${aed.toFixed(2)}`;
  }
  if (typeof dollars === "number") {
    return `AED ${dollars.toFixed(2)}`;
  }
  if (typeof cents === "number") {
    return `AED ${(cents / 100).toFixed(2)}`;
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

const resolveProductKey = (card?: ProductCard | null) => {
  if (!card) return null;
  const key = card.productId ?? card.id ?? card.name;
  return key ? String(key) : null;
};

const CATEGORY_FALLBACK = "All Treats";
const TOAST_DURATION_MS = 3200;

const getCategoryLabel = (card?: ProductCard | null) => {
  if (!card) return CATEGORY_FALLBACK;
  const label = typeof card?.category === "string" ? card.category.trim() : "";
  return label || CATEGORY_FALLBACK;
};

const slugifyCategory = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, "-");

export type ProductShowcaseProps = {
  className?: string;
  directions?: DirectionsPayload | null;
};

export function ProductShowcase({ className, directions }: ProductShowcaseProps = {}) {
  const room = useRoomContext();
  const { agent } = useVoiceAssistant();

  const [mode, setMode] = useState<"menu" | "detail" | "added" | null>(null);
  const [menuCards, setMenuCards] = useState<ProductCard[]>([]);
  const [query, setQuery] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProductCard | null>(null);
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const [cartItems, setCartItems] = useState<CartItemState[]>([]);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [pendingProductId, setPendingProductId] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>("all");

  useEffect(() => {
    if (!room) return;

    const handleProductRpc = async (data: RpcInvocationData): Promise<string> => {
      try {
        const payloadRaw =
          typeof data?.payload === "string" ? data.payload : JSON.stringify(data?.payload ?? {});
        const payload = JSON.parse(payloadRaw) as ProductRpcPayload;

        switch (payload.action) {
          case "menu": {
            const products = payload.products ?? [];
            setMode("menu");
            setMenuCards(products);
            setQuery(payload.query ?? null);
            setDetail(null);
            setSummary(null);
            setPendingProductId(null);
            setActiveCategory("all");
            break;
          }
          case "detail": {
            setMode("detail");
            const detailCard = payload.products?.[0] ?? null;
            setDetail(detailCard ?? null);
            if (payload.query !== undefined) {
              setQuery(payload.query ?? null);
            }
            setSummary(null);
            setPendingProductId(null);
            setMenuCards((prev) => {
              if (prev.length > 0) {
                return prev;
              }
              const incoming = payload.products ?? [];
              return incoming.length > 0 ? incoming : prev;
            });
            break;
          }
          case "added": {
            const summaryPayload = payload.summary ?? null;
            setSummary(summaryPayload);
            const totalCents =
              summaryPayload && typeof summaryPayload["totalCents"] === "number"
                ? (summaryPayload["totalCents"] as number)
                : null;
            const totalDollars =
              summaryPayload && typeof summaryPayload["totalDollars"] === "number"
                ? (summaryPayload["totalDollars"] as number)
                : null;
            const cartShouldReset =
              (totalCents !== null && totalCents <= 0) || (totalDollars !== null && totalDollars <= 0);
            if (cartShouldReset) {
              setCartItems([]);
            }

            if (payload.product) {
              if (!cartShouldReset) {
                const productKey = resolveProductKey(payload.product);
                if (productKey) {
                  const qtyToAdd = Math.max(1, payload.qty ?? 1);
                  setCartItems((prev) => {
                    const next = [...prev];
                    const index = next.findIndex((item) => item.key === productKey);
                    if (index >= 0) {
                      const existing = next[index];
                      next[index] = {
                        key: productKey,
                        qty: existing.qty + qtyToAdd,
                        card: { ...existing.card, ...payload.product },
                      };
                    } else {
                      next.push({
                        key: productKey,
                        qty: qtyToAdd,
                        card: { ...payload.product },
                      });
                    }
                    return next;
                  });
                }
              }

              setMode("added");
              setDetail(payload.product);
              setToast({
                product: payload.product,
                qty: Math.max(1, payload.qty ?? 1),
                expiresAt: Date.now() + TOAST_DURATION_MS,
              });
              setPendingProductId(null);
              setMenuCards((prev) => {
                if (prev.length > 0) {
                  return prev;
                }
                return payload.product ? [payload.product] : prev;
              });
            } else {
              setPendingProductId(null);
            }
            break;
          }
          case "clear": {
            setMode(null);
            setMenuCards([]);
            setQuery(null);
            setDetail(null);
            setSummary(null);
            setPendingProductId(null);
            setCartItems([]);
            setActiveCategory("all");
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

    room.registerRpcMethod("client.products", handleProductRpc);
    return () => {
      room.unregisterRpcMethod("client.products");
    };
  }, [room]);

  useEffect(() => {
    if (!toast) return;
    const remaining = Math.max(toast.expiresAt - Date.now(), 0);
    const timer = window.setTimeout(() => setToast(null), remaining);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const showMenuPanel = mode === "menu" && menuCards.length > 0;

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

  const categories = useMemo(() => {
    const seen = new Set<string>();
    return menuCards.reduce<CategoryOption[]>((acc, card) => {
      const label = getCategoryLabel(card);
      const slug = slugifyCategory(label);
      if (!seen.has(slug)) {
        seen.add(slug);
        acc.push({ label, slug });
      }
      return acc;
    }, []);
  }, [menuCards]);

  const navCategories = useMemo(() => {
    if (!categories.length) return [];
    return [{ label: "All", slug: "all" }, ...categories];
  }, [categories]);

  const normalizedCategory = useMemo(() => {
    if (!categories.length) return "all";
    if (activeCategory === "all") return "all";
    const exists = categories.some((category) => category.slug === activeCategory);
    return exists ? activeCategory : categories[0]?.slug ?? "all";
  }, [activeCategory, categories]);

  const filteredMenuCards = useMemo(() => {
    if (!menuCards.length) return [];
    if (normalizedCategory === "all") return menuCards;
    return menuCards.filter(
      (card) => slugifyCategory(getCategoryLabel(card)) === normalizedCategory
    );
  }, [menuCards, normalizedCategory]);

  const activeCategoryLabel =
    normalizedCategory === "all"
      ? CATEGORY_FALLBACK
      : categories.find((cat) => cat.slug === normalizedCategory)?.label ?? CATEGORY_FALLBACK;

  const primaryCard = detail;
  const primaryCardKey = resolveProductKey(primaryCard);
  const isPendingPrimary = primaryCardKey ? pendingProductId === primaryCardKey : false;
  const primaryLabels = primaryCard ? normalizeDisplayNames(primaryCard.displayName) : [];

  const resolveSummaryValue = (base: "subtotal" | "tax" | "total") => {
    if (!summary) return "--";
    const aedKey = `${base}AED` as const;
    const dollarsKey = `${base}Dollars` as const;
    const centsKey = `${base}Cents` as const;
    const aedValue = summary[aedKey];
    const dollarsValue = summary[dollarsKey];
    const centsValue = summary[centsKey];
    const formatted = formatPrice({
      aed: typeof aedValue === "number" ? (aedValue as number) : undefined,
      dollars: typeof dollarsValue === "number" ? (dollarsValue as number) : undefined,
      cents: typeof centsValue === "number" ? (centsValue as number) : undefined,
    });
    return formatted || "--";
  };

  const summaryMessage = typeof summary?.["message"] === "string" ? (summary?.["message"] as string) : null;

  const renderDetailPanel = () => {
    if (!primaryCard) {
      return null;
    }

    if (mode === "detail") {
      return (
        <div className="space-y-4">
          <div className="flex h-48 w-full items-center justify-center rounded-2xl bg-white">
            {primaryCard.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={primaryCard.imageUrl}
                alt={primaryCard.name ?? "Menu item"}
                className="h-full w-full rounded-2xl object-contain p-2"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center rounded-2xl bg-[color:var(--icecream-primary)]/10 text-sm font-semibold text-[color:var(--icecream-primary)]">
                Scoop
              </div>
            )}
          </div>
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
                {formatPrice({
                  aed: primaryCard.priceAED,
                })}
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
      );
    }

    if (mode === "added") {
      const hasCartItems = cartItems.length > 0;
      const totalItems = cartItems.reduce((acc, item) => acc + item.qty, 0);

      return (
        <div className="space-y-4">
          <div className="flex h-40 w-full items-center justify-center rounded-2xl bg-white">
            {primaryCard.imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={primaryCard.imageUrl}
                alt={primaryCard.name ?? "Menu item"}
                className="h-full w-full rounded-2xl object-contain p-2"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center rounded-2xl bg-[color:var(--icecream-primary)]/10 text-sm font-semibold text-[color:var(--icecream-primary)]">
                Scoop
              </div>
            )}
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--icecream-primary)]">
              Added to your tray
            </p>
            <h3 className="text-xl font-semibold text-[color:var(--icecream-dark)]">
              {primaryCard.name ?? "Treat"}
            </h3>
            <p className="text-sm text-black/70">Scoop is keeping it chilled while you finish up.</p>
          </div>
          {hasCartItems ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-black/40">
                <span>Tray overview</span>
                <span>
                  {totalItems} item{totalItems === 1 ? "" : "s"}
                </span>
              </div>
              <div className="flex max-h-48 flex-wrap gap-3 overflow-y-auto pr-1">
                {cartItems.map(({ key, card, qty }) => {
                  const label = card.name ?? "Treat";
                  return (
                    <div
                      key={key}
                      className="flex w-[108px] flex-col items-center gap-2 rounded-2xl bg-white/80 p-2 text-center shadow-sm"
                    >
                      <div className="relative h-20 w-full overflow-hidden rounded-xl">
                        {card.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={card.imageUrl} alt={label} className="h-full w-full object-contain p-1" />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center rounded-xl bg-[color:var(--icecream-primary)]/10 text-xs font-semibold text-[color:var(--icecream-primary)]">
                            Scoop
                          </div>
                        )}
                        <span className="absolute right-1 top-1 rounded-full bg-[color:var(--icecream-dark)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-white shadow">
                          x{qty}
                        </span>
                      </div>
                      <p className="line-clamp-2 text-xs font-medium text-[color:var(--icecream-dark)]">{label}</p>
                      <p className="text-[11px] text-black/50">
                        {formatPrice({
                          aed: card.priceAED ?? undefined,
                        })}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}
          <div className="rounded-2xl bg-black/5 p-4 text-sm text-black/70">
            <div className="flex justify-between">
              <span>Subtotal</span>
              <span>{resolveSummaryValue("subtotal")}</span>
            </div>
            <div className="flex justify-between">
              <span>Tax</span>
              <span>{resolveSummaryValue("tax")}</span>
            </div>
            <div className="mt-2 flex justify-between text-base font-semibold text-[color:var(--icecream-dark)]">
              <span>Total</span>
              <span>{resolveSummaryValue("total")}</span>
            </div>
            {summaryMessage ? (
              <p className="mt-2 text-xs uppercase tracking-wide text-[color:var(--icecream-primary)]">
                {summaryMessage}
              </p>
            ) : null}
          </div>
          <p className="text-xs text-black/60">Settle up at the counter whenever you&rsquo;re ready.</p>
          <button
            type="button"
            className="inline-flex w-full items-center justify-center gap-2 rounded-full bg-[color:var(--icecream-dark)] px-4 py-3 text-sm font-semibold text-white shadow-lg transition hover:brightness-105"
          >
            Pay at the Counter
          </button>
        </div>
      );
    }

    return null;
  };

  const renderCategoryButtons = (orientation: "vertical" | "horizontal") => {
    if (navCategories.length === 0) {
      return null;
    }
    const isVertical = orientation === "vertical";
    return navCategories.map((category) => {
      const isActive = normalizedCategory === category.slug;
      return (
        <button
          key={category.slug}
          type="button"
          onClick={() => setActiveCategory(category.slug)}
          className={clsx(
            "rounded-full px-4 py-2 text-sm font-medium transition",
            isActive
              ? "bg-[color:var(--icecream-primary)] text-white"
              : "bg-black/5 text-black/70 hover:bg-[color:var(--icecream-primary)]/10 hover:text-[color:var(--icecream-primary)]",
            isVertical ? "w-full text-left" : "whitespace-nowrap"
          )}
        >
          {category.label}
        </button>
      );
    });
  };

  const menuPanel = showMenuPanel ? (
    <div className={clsx("pointer-events-auto w-full max-w-5xl px-4 pb-6 lg:px-0", className)}>
      <div className="rounded-[28px] border border-white/40 bg-white/95 p-6 shadow-2xl backdrop-blur-xl text-[color:var(--icecream-dark)]">
        <div className="flex flex-col gap-6 lg:flex-row">
          <aside className="hidden w-56 shrink-0 rounded-[24px] border border-black/5 bg-white/85 px-5 py-6 lg:flex lg:flex-col lg:gap-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-black/40">Browse</p>
            <div className="mt-4 flex flex-col gap-3">{renderCategoryButtons("vertical")}</div>
          </aside>
          <div className="flex-1 max-w-full">
            <div className="flex flex-col gap-1">
              <h2 className="text-xl font-semibold">Scoop&apos;s Menu</h2>
              <p className="text-sm text-black/60">
                {query
                  ? `Showing flavours inspired by "${query}".`
                  : `Now browsing: ${activeCategoryLabel}.`}
              </p>
            </div>
            <div className="mt-4 flex gap-2 overflow-x-auto lg:hidden">{renderCategoryButtons("horizontal")}</div>
            <div className="mt-4 max-h-[65vh] overflow-y-auto pr-1 lg:pr-4">
              {filteredMenuCards.length ? (
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                  {filteredMenuCards.map((item) => (
                    <article
                      key={item.id ?? item.productId ?? item.name}
                      className="flex h-full flex-col rounded-3xl border border-black/5 bg-white/90 p-4 shadow-sm transition hover:-translate-y-1 hover:shadow-lg"
                    >
                      <div className="flex h-40 w-full items-center justify-center rounded-2xl bg-white">
                        {item.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={item.imageUrl}
                            alt={item.name ?? "Menu item"}
                            className="h-full w-full rounded-2xl object-contain p-2"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center rounded-2xl bg-[color:var(--icecream-primary)]/10 text-sm font-semibold text-[color:var(--icecream-primary)]">
                            Scoop
                          </div>
                        )}
                      </div>
                      <div className="mt-4 flex flex-1 flex-col">
                        <h4 className="text-base font-semibold text-[color:var(--icecream-dark)]">
                          {item.name ?? "Treat"}
                        </h4>
                        {item.description ? (
                          <p className="mt-2 text-sm leading-snug text-black/60 line-clamp-3">{item.description}</p>
                        ) : null}
                        <div className="mt-auto flex items-center justify-between pt-4">
                      <span className="text-sm font-semibold text-[color:var(--icecream-primary)]">
                        {formatPrice({
                          aed: item.priceAED,
                        })}
                      </span>
                          <button
                            type="button"
                            disabled={!agent}
                            onClick={() => handleAddToCartClick(item)}
                            className="rounded-full border border-[color:var(--icecream-primary)] px-4 py-1 text-xs font-semibold text-[color:var(--icecream-primary)] transition hover:bg-[color:var(--icecream-primary)] hover:text-white disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            Add
                          </button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="rounded-3xl bg-white/85 p-6 text-sm text-black/60 shadow-inner">
                  No treats in this category yet. Try another request!
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  const detailPanelContent = renderDetailPanel();

  const detailCard = detailPanelContent ? (
    <div className="flex w-full justify-center lg:justify-end">
      <div className="pointer-events-auto w-full max-w-md px-4 pb-4 lg:fixed lg:right-8 lg:top-1/2 lg:w-auto lg:max-w-sm lg:-translate-y-1/2 lg:px-0 lg:pb-0 lg:z-30">
        <div className="max-h-[85vh] overflow-y-auto rounded-[28px] border border-white/40 bg-white/95 p-6 shadow-2xl backdrop-blur-xl text-[color:var(--icecream-dark)]">
          {detailPanelContent}
        </div>
      </div>
    </div>
  ) : null;


  return (
    <>
      {menuPanel}
      {detailCard}

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
                {formatPrice({
                  aed: toast.product.priceAED ?? undefined,
                })}
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
