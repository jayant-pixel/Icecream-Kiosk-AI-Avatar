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
        <div className="flex flex-col h-full">
          <div className="relative flex-1 w-full overflow-hidden rounded-[32px] bg-white p-6 shadow-xl border border-black/5 overflow-y-auto scrollbar-thin scrollbar-thumb-black/10 scrollbar-track-transparent">
            <div className="flex h-56 w-full items-center justify-center rounded-2xl bg-black/5 mb-6 shadow-inner shrink-0">
              {primaryCard.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={primaryCard.imageUrl}
                  alt={primaryCard.name ?? "Menu item"}
                  className="h-full w-full rounded-2xl object-contain p-4 transition-transform duration-500 hover:scale-105"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center rounded-2xl text-sm font-semibold text-[color:var(--icecream-primary)]">
                  Scoop
                </div>
              )}
            </div>

            <div className="space-y-4 flex-1">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="px-2 py-0.5 rounded-full bg-[color:var(--icecream-primary)]/10 text-[10px] font-bold uppercase tracking-wider text-[color:var(--icecream-primary)]">
                      Scoop recommends
                    </span>
                  </div>
                  <h3 className="text-2xl font-bold text-[color:var(--icecream-dark)] leading-tight">
                    {primaryCard.name ?? "Treat"}
                  </h3>
                </div>
                <span className="text-xl font-bold text-[color:var(--icecream-primary)] bg-black/5 px-3 py-1 rounded-xl shadow-sm">
                  {formatPrice({
                    aed: primaryCard.priceAED,
                  })}
                </span>
              </div>

              {primaryCard.description ? (
                <p className="text-sm leading-relaxed text-black/70 font-medium">{primaryCard.description}</p>
              ) : null}

              {primaryLabels.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {primaryLabels.map((label) => {
                    const key = `${primaryCard.id ?? primaryCard.productId ?? primaryCard.name ?? "treat"}-${label}`;
                    return (
                      <span key={key} className="rounded-full bg-black/5 border border-black/5 px-3 py-1 text-xs font-semibold text-black/60 shadow-sm">
                        {label}
                      </span>
                    );
                  })}
                </div>
              ) : null}

              <div className="pt-4">
                <button
                  type="button"
                  disabled={!agent || isPendingPrimary}
                  onClick={() => handleAddToCartClick(primaryCard)}
                  className="group relative w-full overflow-hidden rounded-2xl bg-[color:var(--icecream-primary)] px-6 py-4 text-sm font-bold text-white shadow-lg transition-all hover:shadow-[0_0_20px_rgba(240,66,153,0.4)] hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 disabled:hover:shadow-none"
                >
                  <div className="relative z-10 flex items-center justify-center gap-2">
                    {isPendingPrimary ? (
                      <>
                        <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                        </svg>
                        <span>Adding to cart...</span>
                      </>
                    ) : (
                      <>
                        <span>Add to cart</span>
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4 transition-transform group-hover:translate-x-1">
                          <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
                        </svg>
                      </>
                    )}
                  </div>
                </button>

                {!agent ? (
                  <p className="mt-3 text-xs text-center font-medium text-black/40">Scoop is getting ready...</p>
                ) : null}
                {agent && isPendingPrimary ? (
                  <p className="mt-3 text-xs text-center font-medium text-[color:var(--icecream-primary)] animate-pulse">
                    Letting Scoop know about your pick...
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      );
    }

    if (mode === "added") {
      const hasCartItems = cartItems.length > 0;
      const totalItems = cartItems.reduce((acc, item) => acc + item.qty, 0);

      return (
        <div className="flex flex-col h-full">
          <div className="relative flex-1 w-full overflow-hidden rounded-[32px] bg-white p-6 shadow-2xl border border-black/5">
            <div className="flex h-40 w-full items-center justify-center rounded-2xl bg-black/5 mb-6 shadow-inner">
              {primaryCard.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={primaryCard.imageUrl}
                  alt={primaryCard.name ?? "Menu item"}
                  className="h-full w-full rounded-2xl object-contain p-2"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center rounded-2xl text-sm font-semibold text-[color:var(--icecream-primary)]">
                  Scoop
                </div>
              )}
            </div>

            <div className="space-y-2 mb-6">
              <div className="flex items-center gap-2">
                <div className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                <p className="text-xs font-bold uppercase tracking-wide text-green-600">
                  Added to your tray
                </p>
              </div>
              <h3 className="text-2xl font-bold text-[color:var(--icecream-dark)]">
                {primaryCard.name ?? "Treat"}
              </h3>
              <p className="text-sm font-medium text-black/60">Scoop is keeping it chilled while you finish up.</p>
            </div>

            {hasCartItems ? (
              <div className="space-y-4 mb-6">
                <div className="flex items-center justify-between text-xs font-bold uppercase tracking-wide text-black/40 border-b border-black/5 pb-2">
                  <span>Tray overview</span>
                  <span>
                    {totalItems} item{totalItems === 1 ? "" : "s"}
                  </span>
                </div>
                <div className="flex max-h-48 flex-wrap gap-3 overflow-y-auto pr-1 scrollbar-thin scrollbar-thumb-black/10 scrollbar-track-transparent">
                  {cartItems.map(({ key, card, qty }) => {
                    const label = card.name ?? "Treat";
                    return (
                      <div
                        key={key}
                        className="group flex w-[108px] flex-col items-center gap-2 rounded-2xl bg-white p-2 text-center shadow-sm border border-black/5 transition-transform hover:-translate-y-1"
                      >
                        <div className="relative h-20 w-full overflow-hidden rounded-xl bg-black/5">
                          {card.imageUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={card.imageUrl} alt={label} className="h-full w-full object-contain p-1" />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center rounded-xl text-xs font-semibold text-[color:var(--icecream-primary)]">
                              Scoop
                            </div>
                          )}
                          <span className="absolute right-1 top-1 rounded-full bg-[color:var(--icecream-dark)] px-2 py-0.5 text-[10px] font-bold text-white shadow-md">
                            x{qty}
                          </span>
                        </div>
                        <p className="line-clamp-2 text-xs font-bold text-[color:var(--icecream-dark)] leading-tight">{label}</p>
                        <p className="text-[11px] font-medium text-black/50">
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

            <div className="mt-auto rounded-2xl bg-black/5 p-5">
              <div className="space-y-2 text-sm font-medium text-black/70">
                <div className="flex justify-between">
                  <span>Subtotal</span>
                  <span>{resolveSummaryValue("subtotal")}</span>
                </div>
                <div className="flex justify-between">
                  <span>Tax</span>
                  <span>{resolveSummaryValue("tax")}</span>
                </div>
                <div className="pt-2 border-t border-black/5 flex justify-between text-lg font-bold text-[color:var(--icecream-dark)]">
                  <span>Total</span>
                  <span>{resolveSummaryValue("total")}</span>
                </div>
              </div>
              {summaryMessage ? (
                <p className="mt-3 text-xs font-bold uppercase tracking-wide text-[color:var(--icecream-primary)]">
                  {summaryMessage}
                </p>
              ) : null}
            </div>

            <div className="mt-4 space-y-3">
              <p className="text-xs text-center font-medium text-black/50">Settle up at the counter whenever you&rsquo;re ready.</p>
              <button
                type="button"
                className="w-full rounded-xl bg-[color:var(--icecream-dark)] px-4 py-3.5 text-sm font-bold text-white shadow-lg transition-all hover:bg-black hover:shadow-xl active:scale-95"
              >
                Pay at the Counter
              </button>
            </div>
          </div>
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
            "rounded-full px-5 py-2.5 text-sm font-bold transition-all duration-300",
            isActive
              ? "bg-[color:var(--icecream-primary)] text-white shadow-md shadow-[color:var(--icecream-primary)]/25"
              : "bg-white text-black/60 hover:bg-black/5 hover:text-[color:var(--icecream-primary)] hover:shadow-sm",
            isVertical ? "w-full text-left" : "whitespace-nowrap"
          )}
        >
          {category.label}
        </button>
      );
    });
  };

  const menuPanel = showMenuPanel ? (
    <div className={clsx("pointer-events-auto w-full max-w-6xl px-4 pb-6 lg:px-0 mx-auto", className)}>
      <div className="rounded-[40px] border border-black/5 bg-white p-8 shadow-2xl text-[color:var(--icecream-dark)]">
        <div className="flex flex-col gap-8 lg:flex-row">
          <aside className="hidden w-64 shrink-0 rounded-[32px] border border-black/5 bg-black/5 px-6 py-8 lg:flex lg:flex-col lg:gap-4">
            <div className="flex items-center gap-2 mb-2 px-2">
              <div className="h-1.5 w-1.5 rounded-full bg-[color:var(--icecream-primary)]" />
              <p className="text-xs font-bold uppercase tracking-widest text-black/40">Browse Menu</p>
            </div>
            <div className="flex flex-col gap-2">{renderCategoryButtons("vertical")}</div>
          </aside>

          <div className="flex-1 max-w-full">
            <div className="flex flex-col gap-2 mb-6">
              <h2 className="text-3xl font-bold tracking-tight">Scoop&apos;s Menu</h2>
              <p className="text-base font-medium text-black/50">
                {query
                  ? `Showing flavours inspired by "${query}".`
                  : `Now browsing: ${activeCategoryLabel}.`}
              </p>
            </div>

            <div className="mb-6 flex gap-2 overflow-x-auto pb-2 lg:hidden scrollbar-hide">{renderCategoryButtons("horizontal")}</div>

            <div className="max-h-[65vh] overflow-y-auto pr-2 lg:pr-4 scrollbar-thin scrollbar-thumb-[color:var(--icecream-primary)]/20 scrollbar-track-transparent">
              {filteredMenuCards.length ? (
                <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                  {filteredMenuCards.map((item) => (
                    <article
                      key={item.id ?? item.productId ?? item.name}
                      className="group flex h-full flex-col rounded-[28px] border border-black/5 bg-white p-4 shadow-sm transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_10px_30px_rgba(0,0,0,0.05)]"
                    >
                      <div className="relative flex h-48 w-full items-center justify-center rounded-2xl bg-black/5 overflow-hidden">
                        {item.imageUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={item.imageUrl}
                            alt={item.name ?? "Menu item"}
                            className="h-full w-full object-contain p-4 transition-transform duration-500 group-hover:scale-110"
                          />
                        ) : (
                          <div className="flex h-full w-full items-center justify-center rounded-2xl text-sm font-semibold text-[color:var(--icecream-primary)]">
                            Scoop
                          </div>
                        )}
                        <button
                          type="button"
                          disabled={!agent}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleAddToCartClick(item);
                          }}
                          className="absolute bottom-3 right-3 h-10 w-10 rounded-full bg-[color:var(--icecream-primary)] text-white shadow-lg flex items-center justify-center opacity-0 translate-y-2 transition-all duration-300 group-hover:opacity-100 group-hover:translate-y-0 hover:bg-[color:var(--icecream-primary)]/90 disabled:opacity-0"
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                            <path d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z" />
                          </svg>
                        </button>
                      </div>

                      <div className="mt-5 flex flex-1 flex-col px-1">
                        <div className="flex justify-between items-start gap-2">
                          <h4 className="text-lg font-bold text-[color:var(--icecream-dark)] leading-tight">
                            {item.name ?? "Treat"}
                          </h4>
                          <span className="shrink-0 text-sm font-bold text-[color:var(--icecream-primary)] bg-[color:var(--icecream-primary)]/5 px-2 py-1 rounded-lg">
                            {formatPrice({
                              aed: item.priceAED,
                            })}
                          </span>
                        </div>

                        {item.description ? (
                          <p className="mt-2 text-sm font-medium leading-relaxed text-black/50 line-clamp-2">{item.description}</p>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-64 rounded-[32px] bg-black/5 border border-dashed border-black/10 text-center p-8">
                  <p className="text-lg font-semibold text-black/40">No treats in this category yet.</p>
                  <p className="text-sm text-black/30 mt-1">Try asking Scoop for something else!</p>
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
      <div className="pointer-events-auto w-full max-w-md px-4 pb-4 lg:fixed lg:right-12 lg:top-1/2 lg:w-auto lg:max-w-[400px] lg:-translate-y-1/2 lg:px-0 lg:pb-0 lg:z-30">
        <div className="max-h-[85vh] overflow-y-auto rounded-[32px] shadow-2xl">
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
        <div className="pointer-events-none fixed bottom-24 left-1/2 z-30 w-full max-w-sm -translate-x-1/2 px-4 sm:left-auto sm:right-8 sm:translate-x-0">
          <div className="pointer-events-auto rounded-[32px] border border-black/5 bg-white p-6 shadow-2xl text-[color:var(--icecream-dark)]">
            <div className="flex items-center gap-2 mb-3">
              <div className="h-2 w-2 rounded-full bg-[color:var(--icecream-primary)] animate-pulse" />
              <p className="text-xs font-bold uppercase tracking-wide text-[color:var(--icecream-primary)]">
                Pickup Spot
              </p>
            </div>
            <h3 className="text-xl font-bold mb-4">
              {directions.display ?? directions.directions?.[0]?.displayName ?? "Pickup"}
            </h3>
            {directions.directions?.[0]?.mapImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={directions.directions[0].mapImage}
                alt={directions.display ?? "Directions"}
                className="h-56 w-full rounded-2xl object-cover shadow-md"
              />
            ) : null}
            {directions.directions?.[0]?.hint ? (
              <p className="mt-4 text-sm font-medium text-black/70 bg-black/5 p-3 rounded-xl border border-black/5">
                {directions.directions[0].hint}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {toast ? (
        <div className="pointer-events-none fixed bottom-12 left-1/2 z-50 w-full max-w-xs -translate-x-1/2 px-4 sm:left-auto sm:right-8 sm:translate-x-0">
          <div className="flex items-center gap-4 rounded-2xl bg-[color:var(--icecream-dark)] px-5 py-4 text-white shadow-2xl border border-white/10">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[color:var(--icecream-primary)] text-white shadow-lg">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-5 h-5">
                <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
              </svg>
            </div>
            <div className="flex-1">
              <p className="text-sm font-bold">
                Added {toast.qty} x {toast.product.name ?? "treat"}
              </p>
              <p className="text-xs opacity-70 font-medium mt-0.5">
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
