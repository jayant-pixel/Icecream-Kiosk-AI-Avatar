"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReceivedDataMessage } from "@livekit/components-core";
import { useDataChannel, useRoomContext, useVoiceAssistant } from "@livekit/components-react";
import type { RpcInvocationData } from "livekit-client";
import type { DirectionsPayload } from "./ProductShowcase";
import clsx from "clsx";

type ProductCard = {
  id?: string;
  name?: string;
  category?: "Cups" | "Sundae Cups" | "Milk Shakes" | string | null;
  size?: string | null;
  scoops?: number | null;
  priceAED?: number | null;
  imageUrl?: string | null;
  display?: string | null;
  includedToppings?: number | null;
};

type ProductGridPayload = {
  kind: "products";
  view: "grid";
  category?: string;
  size?: string | null;
  query?: string | null;
  products?: ProductCard[];
  cartSummary?: CartSummary;
  overlayId?: string;
};

type ProductDetailPayload = {
  kind: "products";
  view: "detail";
  product?: ProductCard;
  products?: ProductCard[];
  selectedFlavors?: FlavorSelection[];
  selectedToppings?: ToppingSelection[];
  flavorSummary?: SummaryNote;
  toppingSummary?: SummaryNote;
  sizeOptions?: SizeOption[];
  contextProductId?: string;
  cartSummary?: CartSummary;
  overlayId?: string;
};

type FlavorSelection = {
  id?: string;
  name?: string;
  classification?: string | null;
  imageUrl?: string | null;
  isExtra?: boolean;
};

type ToppingSelection = {
  id?: string;
  name?: string;
  priceAED?: number | null;
  imageUrl?: string | null;
  isFree?: boolean;
};

type SummaryNote = {
  label?: string;
  extraNote?: string | null;
};

type SizeOption = {
  id?: string;
  size?: string | null;
  priceAED?: number | null;
};

type FlavorCatalogCard = {
  id?: string;
  name?: string;
  classification?: "choco" | "berry" | "others" | "sugarless" | string | null;
  imageUrl?: string | null;
  available?: boolean;
};

type FlavorOverlayPayload = {
  kind: "flavors";
  productId?: string;
  productName?: string;
  freeFlavors?: number;
  maxFlavors?: number;
  selectedFlavorIds?: string[];
  selectedFlavors?: FlavorSelection[];
  usedFreeFlavors?: number;
  extraFlavorCount?: number;
  flavors?: FlavorCatalogCard[];
  overlayId?: string;
};

type ToppingCatalogCard = {
  id?: string;
  name?: string;
  priceAED?: number | null;
  imageUrl?: string | null;
};

type ToppingOverlayPayload = {
  kind: "toppings";
  productId?: string;
  productName?: string;
  category?: string | null;
  note?: string | null;
  freeToppings?: number;
  freeToppingsRemaining?: number;
  selectedToppingIds?: string[];
  selectedToppings?: ToppingSelection[];
  toppings?: ToppingCatalogCard[];
  overlayId?: string;
};

type CartFlavor = {
  id?: string;
  name?: string;
  imageUrl?: string | null;
  isExtra?: boolean;
  unitPriceAED?: number | null;
  qty?: number | null;
  linePriceAED?: number | null;
};

type CartTopping = {
  id?: string;
  name?: string;
  isFree?: boolean;
  priceAED?: number | null;
  imageUrl?: string | null;
  unitPriceAED?: number | null;
  qty?: number | null;
  linePriceAED?: number | null;
};

type CartItem = {
  lineId?: string;
  product_id?: string;
  name?: string;
  category?: string;
  size?: string | null;
  imageUrl?: string | null;
  display?: string | null;
  qty?: number;
  flavors?: CartFlavor[];
  toppings?: CartTopping[];
  basePriceAED?: number | null;
  flavorExtrasAED?: number | null;
  toppingExtrasAED?: number | null;
  lineTotalAED?: number | null;
};

type CartSummary = {
  subtotalAED?: number | null;
  taxAED?: number | null;
  totalAED?: number | null;
  message?: string;
};

type CartOverlayPayload = {
  kind: "cart";
  cart?: {
    items?: CartItem[];
    subtotalAED?: number | null;
    taxAED?: number | null;
    totalAED?: number | null;
    message?: string;
  };
  overlayId?: string;
};

type CartRpcPayload = {
  cart?: CartOverlayPayload["cart"];
};

type DirectionLocation = {
  displayName?: string;
  hint?: string;
  mapImage?: string | null;
  products?: string[];
};

type DirectionsOverlayPayload = {
  kind: "directions";
  locations?: DirectionLocation[];
  overlayId?: string;
};

type UpgradeOverlayPayload = {
  kind: "upgrade";
  show: boolean;
  fromProduct?: ProductCard;
  toProduct?: (ProductCard & { headline?: string | null; subline?: string | null }) | null;
  priceDiffAED?: number | null;
  savingsEstimateAED?: number | null;
  uiCopy?: {
    bannerTitle?: string;
    primaryCtaLabel?: string;
    secondaryCtaLabel?: string;
  };
  overlayId?: string;
};

type ClearOverlayPayload = { kind: "clear"; overlayId?: string };

type ProductsOverlayPayload = ProductGridPayload | ProductDetailPayload;

type OverlayPayload =
  | ProductsOverlayPayload
  | FlavorOverlayPayload
  | ToppingOverlayPayload
  | CartOverlayPayload
  | DirectionsOverlayPayload
  | UpgradeOverlayPayload
  | ClearOverlayPayload
  | { kind: string; overlayId?: string };

type OverlayLayerKind = "products" | "flavors" | "toppings" | "cart" | "directions";

type OverlayLayerProps = {
  rpcDirections?: DirectionsPayload | null;
};

type CartIndicator = { count: number; total: number };

const decoder = new TextDecoder();
const OVERLAY_TOPIC = "ui.overlay";
const CATEGORY_OPTIONS = ["All", "Cups", "Sundae Cups", "Milk Shakes"];
const FLAVOR_TABS = ["All", "Choco", "Berry", "Classics", "SugarLess"];

function parseRpcPayload<T>(data?: RpcInvocationData): T | null {
  if (!data?.payload) {
    return null;
  }
  try {
    return JSON.parse(data.payload) as T;
  } catch (error) {
    console.error("Failed to parse RPC payload", error);
    return null;
  }
}

/**
 * UPDATED: use `payload.locations` (not `payload.directions`)
 * and type each entry as DirectionLocation to avoid implicit any.
 */
const rpcDirectionsToLocations = (payload: DirectionsPayload): DirectionLocation[] => {
  const entries: DirectionLocation[] =
    "locations" in payload && Array.isArray(payload.locations)
      ? (payload.locations as DirectionLocation[])
      : [];

  const displayFallback = payload.display ?? payload.displayName;
  const normalized: DirectionLocation[] = entries.map((entry: DirectionLocation) => ({
    displayName: entry.displayName ?? displayFallback,
    hint: entry.hint ?? undefined,
    mapImage: entry.mapImage ?? null,
    products: entry.products,
  }));

  if (!normalized.length && displayFallback) {
    normalized.push({ displayName: displayFallback });
  }

  return normalized;
};

export function OverlayLayer({ rpcDirections }: OverlayLayerProps = {}) {
  const room = useRoomContext();
  const { agent } = useVoiceAssistant();
  const [productPayload, setProductPayload] = useState<ProductsOverlayPayload | null>(null);
  const [flavorPayload, setFlavorPayload] = useState<FlavorOverlayPayload | null>(null);
  const [toppingPayload, setToppingPayload] = useState<ToppingOverlayPayload | null>(null);
  const [cartPayload, setCartPayload] = useState<CartOverlayPayload | null>(null);
  const [directionsPayload, setDirectionsPayload] = useState<DirectionsOverlayPayload | null>(null);
  const [upgradePayload, setUpgradePayload] = useState<UpgradeOverlayPayload | null>(null);
  const [activeLayer, setActiveLayer] = useState<OverlayLayerKind>("products");
  const [panelLayer, setPanelLayer] = useState<"flavors" | "toppings" | null>(null);
  const [cartIndicator, setCartIndicator] = useState<CartIndicator>({ count: 0, total: 0 });
  const [menuCache, setMenuCache] = useState<ProductGridPayload | null>(null);

  const sendOverlayAck = useCallback(
    async ({
      overlayId,
      productId,
      kind,
      status = "shown",
    }: {
      overlayId?: string;
      productId?: string;
      kind?: string;
      status?: string;
    }) => {
      if (!overlayId || !room || !agent?.identity) {
        return;
      }
      const destinationIdentity =
        agent.attributes?.["agentControllerIdentity"] ??
        agent.attributes?.["agentcontrolleridentity"] ??
        agent.identity;
      if (!destinationIdentity) {
        return;
      }
      try {
        await room.localParticipant.performRpc({
          destinationIdentity,
          method: "agent.overlayAck",
          payload: JSON.stringify({
            overlayId,
            productId,
            kind,
            status,
          }),
        });
      } catch (error) {
        console.warn("Failed to send overlay ack", error);
      }
    },
    [agent, room]
  );

  const extractProductId = useCallback((payload: OverlayPayload): string | undefined => {
    if ("contextProductId" in payload && payload.contextProductId) {
      return payload.contextProductId;
    }
    if ("productId" in payload && payload.productId) {
      return payload.productId;
    }
    if ("product" in payload && payload.product?.id) {
      return payload.product.id;
    }
    if ("cart" in payload && payload.cart?.items?.length) {
      const firstItem = payload.cart.items.find((item) => item.product_id);
      if (firstItem?.product_id) {
        return firstItem.product_id;
      }
    }
    if (
      "highlightedProductId" in payload &&
      typeof payload.highlightedProductId === "string" &&
      payload.highlightedProductId.length > 0
    ) {
      return payload.highlightedProductId;
    }
    return undefined;
  }, []);

  const handleOverlayMessage = useCallback(
    (payload: OverlayPayload) => {
      switch (payload.kind) {
        case "products": {
          const productsPayload = payload as ProductsOverlayPayload;
          setProductPayload(productsPayload);
          setActiveLayer("products");
          setPanelLayer(null);
          if (productsPayload.view === "grid") {
            setMenuCache(productsPayload as ProductGridPayload);
            setFlavorPayload(null);
            setToppingPayload(null);
            setUpgradePayload(null);
          }
          const summary = (productsPayload as ProductGridPayload | ProductDetailPayload).cartSummary;
          if (summary && typeof summary.totalAED === "number") {
            setCartIndicator((prev) => ({ count: prev.count, total: summary.totalAED ?? prev.total }));
          }
          break;
        }
        case "flavors":
          setFlavorPayload(payload as FlavorOverlayPayload);
          setPanelLayer("flavors");
          break;
        case "toppings":
          setToppingPayload(payload as ToppingOverlayPayload);
          setPanelLayer("toppings");
          break;
        case "cart": {
          const cartData = payload as CartOverlayPayload;
          setCartPayload(cartData);
          setActiveLayer("cart");
          setPanelLayer(null);
          const count = cartData.cart?.items?.length ?? 0;
          const total = cartData.cart?.totalAED ?? 0;
          setCartIndicator({ count, total });
          break;
        }
        case "directions":
          setDirectionsPayload(payload as DirectionsOverlayPayload);
          setActiveLayer("directions");
          setPanelLayer(null);
          break;
        case "upgrade":
          setUpgradePayload(payload as UpgradeOverlayPayload);
          break;
        case "clear":
          setFlavorPayload(null);
          setToppingPayload(null);
          setCartPayload(null);
          setDirectionsPayload(null);
          setActiveLayer("products");
          setPanelLayer(null);
          break;
        default:
          break;
      }
      const status = payload.kind === "clear" ? "cleared" : "shown";
      void sendOverlayAck({
        overlayId: payload.overlayId,
        productId: extractProductId(payload),
        kind: payload.kind,
        status,
      });
    },
    [extractProductId, sendOverlayAck]
  );

  const handleOverlayPacket = useCallback(
    (raw: Uint8Array) => {
      try {
        const decoded = decoder.decode(raw);
        const json = JSON.parse(decoded);
        if (json?.type !== "ui.overlay" || !json.payload) {
          return;
        }
        if (process.env.NODE_ENV !== "production") {
          console.debug("[overlay]", json.payload);
        }
        handleOverlayMessage(json.payload as OverlayPayload);
      } catch (error) {
        console.warn("Ignoring malformed overlay payload", error);
      }
    },
    [handleOverlayMessage]
  );

  useDataChannel(
    OVERLAY_TOPIC,
    useCallback(
      (msg: ReceivedDataMessage<typeof OVERLAY_TOPIC>) => {
        if (msg?.payload) {
          handleOverlayPacket(msg.payload);
        }
      },
      [handleOverlayPacket]
    )
  );

  useEffect(() => {
    if (!room) return;

    const handleMenuLoaded = async (data: RpcInvocationData): Promise<string> => {
      try {
        const payload = parseRpcPayload<Record<string, unknown>>(data);
        console.log("menuLoaded", payload);
        return "ok";
      } catch (error) {
        console.error("Error handling menuLoaded RPC", error);
        return "error";
      }
    };

    const handleCartUpdated = async (data: RpcInvocationData): Promise<string> => {
      try {
        const payload = parseRpcPayload<CartRpcPayload>(data);
        console.log("cartUpdated", payload);
        if (payload?.cart) {
          setCartPayload({ kind: "cart", cart: payload.cart });
          setActiveLayer("cart");
          setPanelLayer(null);
          const count = payload.cart.items?.length ?? 0;
          const total = payload.cart.totalAED ?? 0;
          setCartIndicator({ count, total });
        }
        return "ok";
      } catch (error) {
        console.error("Error handling cartUpdated RPC", error);
        return "error";
      }
    };

    room.registerRpcMethod("client.menuLoaded", handleMenuLoaded);
    room.registerRpcMethod("client.cartUpdated", handleCartUpdated);
    return () => {
      room.unregisterRpcMethod("client.menuLoaded");
      room.unregisterRpcMethod("client.cartUpdated");
    };
  }, [room]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!rpcDirections) {
      return;
    }
    if (rpcDirections.action === "clear") {
      setDirectionsPayload(null);
      setActiveLayer("products");
      setPanelLayer(null);
      return;
    }
    const locations = rpcDirectionsToLocations(rpcDirections);
    setDirectionsPayload({ kind: "directions", locations });
    setActiveLayer("directions");
    setPanelLayer(null);
  }, [rpcDirections]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const panelContent = useMemo(() => {
    if (panelLayer === "flavors" && flavorPayload) {
      return <FlavorsOverlay payload={flavorPayload} />;
    }
    if (panelLayer === "toppings" && toppingPayload) {
      return <ToppingsOverlay payload={toppingPayload} />;
    }
    return null;
  }, [flavorPayload, panelLayer, toppingPayload]);

  const detailElement =
    productPayload?.view === "detail" ? (
      <ProductDetailOverlay
        payload={productPayload as ProductDetailPayload}
        cartIndicator={cartIndicator}
        upgrade={upgradePayload?.show ? upgradePayload : null}
      />
    ) : null;

  const gridElement =
    productPayload?.view === "grid" ? (
      <ProductGridOverlay payload={productPayload as ProductGridPayload} cartIndicator={cartIndicator} />
    ) : null;

  const showMenuColumn = Boolean(detailElement && menuCache && !panelLayer);

  const renderCard = useCallback((content: ReactNode, widthClass: string) => {
    if (!content) {
      return null;
    }
    return (
      <div
        className={clsx(
          "w-full shrink-0 overflow-hidden rounded-[32px] border border-black/5 bg-white/95 p-4 shadow-2xl",
          "max-h-[calc(100vh-5rem)]",
          widthClass
        )}
      >
        <div className="h-full overflow-y-auto pr-1">{content}</div>
      </div>
    );
  }, []);

  let overlayBody: ReactNode = null;
  const containerClass = "w-full h-full px-1 sm:px-2 lg:px-6";
  const cartContent = cartPayload?.cart;

  if (activeLayer === "cart" && cartContent) {
    overlayBody = (
      <div className={clsx(containerClass, "flex justify-start")}>
        {renderCard(<CartOverlay payload={cartContent} />, "max-w-[420px]")}
      </div>
    );
  } else if (activeLayer === "directions" && directionsPayload) {
    overlayBody = (
      <div className={clsx(containerClass, "flex justify-start")}>
        {renderCard(<DirectionsOverlay payload={directionsPayload} />, "max-w-[420px]")}
      </div>
    );
  } else if (panelContent && detailElement) {
    overlayBody = (
      <div className={clsx(containerClass, "flex items-start justify-between gap-6")}>
        {renderCard(panelContent, "max-w-[360px]")}
        {renderCard(detailElement, "max-w-[520px]")}
      </div>
    );
  } else if (showMenuColumn && detailElement && menuCache) {
    overlayBody = (
      <div className={clsx(containerClass, "flex items-start justify-between gap-6")}>
        {renderCard(detailElement, "max-w-[520px]")}
        {renderCard(<ProductGridOverlay payload={menuCache} cartIndicator={cartIndicator} compact />, "max-w-[520px]")}
      </div>
    );
  } else if (detailElement) {
    overlayBody = (
      <div className={clsx(containerClass, "flex justify-end")}>
        {renderCard(detailElement, "max-w-[520px]")}
      </div>
    );
  } else if (gridElement) {
    overlayBody = (
      <div className={clsx(containerClass, "flex justify-end")}>
        {renderCard(gridElement, "max-w-[520px]")}
      </div>
    );
  } else if (panelContent) {
    overlayBody = (
      <div className={clsx(containerClass, "flex justify-start")}>
        {renderCard(panelContent, "max-w-[360px]")}
      </div>
    );
  }

  if (!overlayBody) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute inset-0 px-1 py-6 sm:px-2 lg:px-6">
      <div className="pointer-events-auto h-full w-full">{overlayBody}</div>
    </div>
  );
}
function ProductGridOverlay({
  payload,
  cartIndicator,
  compact,
}: {
  payload: ProductGridPayload;
  cartIndicator?: CartIndicator;
  compact?: boolean;
}) {
  const products = payload.products ?? [];
  return (
    <div className={clsx("space-y-4", compact && "max-h-[70vh] overflow-hidden")}>
      {compact ? (
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold uppercase tracking-wide text-[color:var(--icecream-primary)]">Menu</p>
          {cartIndicator ? (
            <span className="text-xs font-semibold text-[color:var(--icecream-primary)]">
              Cart ({cartIndicator.count}) | {formatDirham(cartIndicator.total)}
            </span>
          ) : null}
        </div>
      ) : (
        <HeaderBar cartIndicator={cartIndicator} subtitle="Browse every treat on the screen" />
      )}
      <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-[color:var(--icecream-dark)]">
        <span>Categories:</span>
        {CATEGORY_OPTIONS.map((category) => (
          <span
            key={category}
            className={clsx(
              "cursor-default rounded-full px-3 py-1",
              (payload.category ?? "All") === category ? "bg-[color:var(--icecream-primary)] text-black" : "bg-black/5 text-black/60"
            )}
          >
            {category}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wide text-black/60">
        <FilterBadge label="Size" />
        <FilterBadge label="Price" />
        <FilterBadge label="Type" />
      </div>
      <div className={clsx("overflow-y-auto pr-2", compact ? "max-h-[55vh]" : "max-h-[60vh]")}>
        {products.length === 0 ? (
          <div className="rounded-3xl border border-dashed border-black/10 p-6 text-center text-sm text-black/60">
            No treats match this filter right now.
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {products.map((product) => (
              <article key={product.id ?? product.name} className="flex flex-col rounded-3xl border border-black/5 bg-white/95 p-3 shadow-sm">
                <CardImage src={product.imageUrl} alt={product.name} className="h-36" />
                <div className="mt-3 space-y-1">
                  <p className="text-base font-semibold text-[color:var(--icecream-dark)]">{product.name ?? "Treat"}</p>
                  <p className="text-xs uppercase tracking-wide text-black/45">{product.category ?? "Menu"}</p>
                  <p className="text-sm font-semibold text-[color:var(--icecream-primary)]">{formatDirham(product.priceAED)}</p>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between text-xs text-black/60">
        <span>Home</span>
        <span>Need Help?</span>
      </div>
    </div>
  );
}


function ProductDetailOverlay({
  payload,
  cartIndicator,
  upgrade,
}: {
  payload: ProductDetailPayload;
  cartIndicator: CartIndicator;
  upgrade: UpgradeOverlayPayload | null;
}) {
  const product = payload.product;
  if (!product) {
    return (
      <div className="space-y-4">
        <HeaderBar cartIndicator={cartIndicator} subtitle="Treat detail" showBack />
        <div className="rounded-[28px] border border-black/5 bg-white/95 p-6 text-sm text-black/60 shadow-inner">
          Choose an item from the menu to see its details here.
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <HeaderBar cartIndicator={cartIndicator} subtitle={product.category ?? "Treat detail"} showBack />
      <div className="rounded-[28px] border border-black/5 bg-white/95 p-4 shadow-inner">
        <div className="flex flex-col gap-4 lg:flex-row">
          <div className="w-full lg:w-1/3">
            <CardImage src={product?.imageUrl} alt={product?.name} className="h-48" />
          </div>
          <div className="flex-1 space-y-2">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-[color:var(--icecream-primary)]">{product?.category}</p>
              <h2 className="text-xl font-semibold text-black">{product?.name ?? "Treat"}</h2>
              <p className="text-xs text-black/60">
                Size: {product?.size ?? "-"}
                {typeof product?.scoops === "number" ? ` · ${product?.scoops} scoop${product?.scoops === 1 ? "" : "s"}` : null}
              </p>
              {product.display ? <p className="text-[10px] text-black/60">Pickup: {product.display}</p> : null}
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-lg font-bold text-[color:var(--icecream-primary)]">{formatDirham(product?.priceAED)}</span>
              <span className="text-xs text-black/40">base price</span>
            </div>
            <div className="rounded-xl bg-black/5 px-3 py-2 text-xs text-black/70">
              <div className="flex justify-between">
                <span>Included Flavors</span>
                <span className="font-medium">{product?.scoops ?? 0}</span>
              </div>
              <div className="flex justify-between">
                <span>Included Toppings</span>
                <span className="font-medium">{product?.includedToppings ?? 0}</span>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 text-[10px]">
              <ActionPill label="Choose Flavors" />
              <ActionPill label="Add Toppings" />
            </div>

            <div className="flex items-center gap-2 pt-1">
              <div className="flex items-center gap-2 rounded-full border border-black/10 bg-white px-3 py-1 shadow-sm">
                <span className="text-[10px] font-bold uppercase text-black">Qty</span>
                <QuantityBadge />
              </div>
              <button type="button" className="flex-1 rounded-full bg-[color:var(--icecream-primary)] px-4 py-2 text-sm font-bold text-white shadow-md transition-transform active:scale-95 hover:scale-105">
                Add to Cart
              </button>
            </div>
          </div>
        </div>

        {/* Integrated Summaries */}
        <div className="mt-4 space-y-2 border-t border-black/5 pt-2">
          <SelectionSummary
            title="Selected Flavors"
            summary={payload.flavorSummary}
            items={payload.selectedFlavors}
            emptyLabel="No flavors selected."
            actionLabel="Change"
          />
          <SelectionSummary
            title="Selected Toppings"
            summary={payload.toppingSummary}
            items={payload.selectedToppings}
            emptyLabel="No toppings selected."
            actionLabel="Change"
          />
        </div>
      </div>

      {upgrade?.show ? <UpgradeBanner payload={upgrade} /> : null}
      <SizeOptions sizeOptions={payload.sizeOptions} />
    </div>
  );
}

function FlavorsOverlay({ payload }: { payload: FlavorOverlayPayload }) {
  const selectedCount = payload.selectedFlavorIds?.length ?? payload.selectedFlavors?.length ?? 0;
  const freeAllotment = payload.freeFlavors ?? selectedCount;
  const totalSlots = payload.maxFlavors ?? freeAllotment;
  const usedScoops = payload.usedFreeFlavors ?? Math.min(selectedCount, freeAllotment);
  const dots = buildScoopsDots(totalSlots, selectedCount);
  return (
    <div className="space-y-3">
      <OverlaySectionHeader title="Choose Your Flavors" subtitle={payload.productName} />
      <div className="flex flex-wrap items-center gap-2 text-sm font-semibold text-black/70">
        <span>Scoops available:</span>
        <div className="flex items-center gap-1">{dots}</div>
        <span className="text-xs font-medium text-black/50">({usedScoops} of {totalSlots} used)</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wide text-black/60">
        {FLAVOR_TABS.map((tab) => (
          <span
            key={tab}
            className={clsx(
              "rounded-full px-3 py-1",
              tab === "All" ? "bg-[color:var(--icecream-primary)] text-black" : "bg-black/5 text-black/50"
            )}
          >
            {tab}
          </span>
        ))}
      </div>
      <div className="max-h-[50vh] overflow-y-auto pr-3">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-2">
          {(payload.flavors ?? []).map((flavor) => {
            const selected = payload.selectedFlavorIds?.includes(flavor.id ?? "");
            return (
              <article
                key={flavor.id ?? flavor.name}
                className={clsx(
                  "flex flex-col rounded-3xl border border-black/5 bg-white/95 p-4 text-center shadow-sm transition-all cursor-pointer hover:shadow-md",
                  selected && "border-[color:var(--icecream-primary)] shadow-[0_8px_20px_rgba(255,86,162,0.2)]"
                )}
              >
                <CardImage src={flavor.imageUrl} alt={flavor.name} className="h-32 bg-white" contain />
                <div className="mt-3 space-y-1">
                  <p className="text-base font-semibold text-[color:var(--icecream-dark)]">{flavor.name}</p>
                  <p className="text-[11px] uppercase tracking-wide text-black/50">{flavor.classification ?? ""}</p>
                </div>
                {selected && (
                  <div className="mt-3 flex items-center justify-center">
                    <span className="inline-flex items-center gap-1 text-sm font-semibold text-[color:var(--icecream-primary)]">
                      <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                      </svg>
                      Selected
                    </span>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </div>
      <div className="flex items-center justify-between rounded-2xl bg-black/5 px-4 py-3 text-xs text-black/70">
        <span>
          Selected: {payload.selectedFlavors?.map((flavor) => flavor.name).filter(Boolean).join(", ") || "None"}
        </span>
        <div className="flex items-center gap-2">
          <ActionPill label="Clear" minimal />
          <ActionPill label="Confirm" />
        </div>
      </div>
    </div>
  );
}

function ToppingsOverlay({ payload }: { payload: ToppingOverlayPayload }) {
  const toppings = payload.toppings ?? [];
  const selectedIds = new Set(payload.selectedToppingIds ?? []);
  const groupFive = toppings.filter((topping) => !topping.priceAED || topping.priceAED <= 5.01);
  const groupSix = toppings.filter((topping) => topping.priceAED && topping.priceAED > 5.01);
  const selectedToppings = payload.selectedToppings ?? [];
  const freeSelected = selectedToppings.filter((topping) => topping.isFree).length;
  const extraSelected = Math.max(selectedToppings.length - freeSelected, 0);
  const extraCost = selectedToppings.filter((topping) => !topping.isFree).reduce((sum, topping) => sum + (topping.priceAED ?? 0), 0);
  return (
    <div className="space-y-3">
      <OverlaySectionHeader title="Add Toppings" subtitle={payload.note ?? payload.productName} />
      <div className="rounded-2xl bg-black/5 px-4 py-3 text-xs text-black/70">
        <p>
          Free toppings remaining: {payload.freeToppingsRemaining ?? 0}
          {payload.category ? ` (${payload.category})` : ""}
        </p>
        <p className="text-[11px] text-black/50">Extra toppings cost 5 or 6 dirham each.</p>
      </div>
      <div className="max-h-[50vh] space-y-4 overflow-y-auto pr-3">
        <ToppingPriceGroup title="Toppings - 5 dirham" items={groupFive} selectedIds={selectedIds} />
        <ToppingPriceGroup title="Toppings - 6 dirham" items={groupSix} selectedIds={selectedIds} />
      </div>
      <div className="space-y-2 rounded-2xl bg-black/5 px-4 py-3 text-xs text-black/70">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>
            Selected: {payload.selectedToppings?.map((topping) => topping.name).filter(Boolean).join(", ") || "None"}
          </span>
          <span>
            Free: {freeSelected} · Extra: {extraSelected}
            {extraSelected > 0 ? ` (+${formatDirham(extraCost)})` : ""}
          </span>
        </div>
        <div className="flex items-center justify-end gap-2">
          <ActionPill label="Clear" minimal />
          <ActionPill label="Confirm" />
        </div>
      </div>
    </div>
  );
}

function CartOverlay({ payload }: { payload: NonNullable<CartOverlayPayload["cart"]> }) {
  const items = payload.items ?? [];
  return (
    <div className="space-y-4 text-[color:var(--icecream-dark)]">
      <OverlaySectionHeader title="Your Cart" subtitle="Everything ready for pickup" showBack />
      {items.length === 0 ? (
        <div className="rounded-3xl bg-white/90 p-6 text-center text-sm text-black/60">Cart is empty for now.</div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const qty = item.qty ?? 1;
            const unitTotal = qty ? (item.lineTotalAED ?? 0) / qty : item.lineTotalAED ?? 0;
            const productName = item.name ?? "";
            const sizeLabel = item.size ?? "";
            const showSize =
              sizeLabel && !productName.toLowerCase().includes(sizeLabel.toLowerCase());
            return (
              <article key={item.lineId ?? item.product_id ?? item.name} className="space-y-3 rounded-3xl border border-black/5 bg-white/95 p-4 shadow-sm">
                <div className="flex gap-3">
                  <div className="h-20 w-20 shrink-0">
                    <CardImage src={item.imageUrl} alt={item.name} className="h-20 w-20" contain />
                  </div>
                  <div className="flex-1 space-y-1">
                    <p className="text-base font-semibold">
                      {productName}
                      {showSize ? ` - ${sizeLabel}` : ""}
                      {item.category ? ` (${item.category})` : ""}
                    </p>
                    {item.display ? <p className="text-xs text-black/50">Pickup: {item.display}</p> : null}
                    <div className="flex flex-wrap gap-3 text-[11px] text-black/70">
                      <span>Base {formatDirham(item.basePriceAED)}</span>
                      {item.flavorExtrasAED ? <span>Flavor add-ons +{formatDirham(item.flavorExtrasAED)}</span> : null}
                      {item.toppingExtrasAED ? <span>Topping add-ons +{formatDirham(item.toppingExtrasAED)}</span> : null}
                    </div>
                  </div>
                </div>
                <CartFlavorList flavors={item.flavors} />
                <CartToppingList toppings={item.toppings} />
                <div className="flex items-center justify-between">
                  <div className="space-y-1 text-xs text-black/60">
                    <div className="flex items-center gap-2">
                      Qty:
                      <QuantityBadge value={qty} />
                    </div>
                    <p>
                      Per treat: <span className="font-semibold text-black/80">{formatDirham(unitTotal)}</span>
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold text-[color:var(--icecream-primary)]">{formatDirham(item.lineTotalAED)}</p>
                    <p className="text-[11px] text-black/50">Line total</p>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
      <div className="space-y-1 rounded-3xl bg-black/5 px-4 py-3 text-sm text-black/70">
        <div className="flex justify-between">
          <span>Subtotal</span>
          <span>{formatDirham(payload.subtotalAED)}</span>
        </div>
        <div className="flex justify-between">
          <span>Tax / Fees</span>
          <span>{formatDirham(payload.taxAED)}</span>
        </div>
        <div className="flex justify-between text-base font-semibold text-[color:var(--icecream-dark)]">
          <span>Total</span>
          <span>{formatDirham(payload.totalAED)}</span>
        </div>
      </div>
      <div className="flex items-center justify-between text-xs text-black/60">
        <ActionPill label="Add More Items" minimal />
        <ActionPill label="Go to Pickup Instructions" />
      </div>
    </div>
  );
}

function DirectionsOverlay({ payload }: { payload: DirectionsOverlayPayload }) {
  const locations = payload.locations ?? [];
  if (locations.length === 0) {
    return (
      <div className="space-y-3 text-center text-sm text-black/60">
        <OverlaySectionHeader title="Pickup Instructions" />
        <p>Maps will appear here once the agent confirms your pickup spot.</p>
      </div>
    );
  }
  if (locations.length === 1) {
    const location = locations[0];
    return (
      <div className="space-y-4">
        <OverlaySectionHeader title="Pickup Instructions" subtitle={`Location: ${location.displayName ?? "-"}`} showBack />
        <div className="rounded-3xl border border-black/5 bg-white/95 p-4 text-sm text-black/70">
          <p>Pickup For: Your Order</p>
          <p>Location: {location.displayName ?? "-"}</p>
        </div>
        <CardImage src={location.mapImage} alt={location.displayName} className="h-64" />
        <p className="text-sm text-black/70">Hint: {location.hint ?? "Check the signage by the counter."}</p>
        {location.products?.length ? (
          <p className="text-xs text-black/60">Collect: {location.products.join(", ")}</p>
        ) : null}
        <div className="flex items-center justify-between text-xs text-black/60">
          <ActionPill label="Done" />
          <ActionPill label="New Order" minimal />
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <OverlaySectionHeader title="Pickup Instructions" showBack />
      <div className="space-y-3">
        {locations.map((location, index) => (
          <article key={location.displayName ?? index} className="space-y-2 rounded-2xl border border-black/5 bg-white/95 p-4 shadow-sm">
            <p className="text-sm font-semibold">Step {index + 1} – {location.displayName ?? `Station ${index + 1}`}</p>
            <div className="space-y-1 text-xs text-black/60">
              {location.products?.length ? <p>• Collect: {location.products.join(", ")}</p> : null}
              <p>• Hint: {location.hint ?? "Look for Scoop signage."}</p>
              {location.mapImage ? (
                <a
                  href={location.mapImage}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center font-semibold text-[color:var(--icecream-primary)]"
                >
                  • View Photo
                </a>
              ) : null}
            </div>
          </article>
        ))}
      </div>
      <div className="flex items-center justify-between text-xs text-black/60">
        <ActionPill label="Done" />
        <ActionPill label="New Order" minimal />
      </div>
    </div>
  );
}

function UpgradeBanner({ payload }: { payload: UpgradeOverlayPayload }) {
  if (!payload.show || !payload.toProduct) {
    return null;
  }
  const primaryLabel = payload.uiCopy?.primaryCtaLabel ?? `Upgrade to ${payload.toProduct.name}`;
  const secondaryLabel = payload.uiCopy?.secondaryCtaLabel ?? "Keep Current Choice";
  return (
    <div className="rounded-[28px] border border-dashed border-[color:var(--icecream-primary)] bg-[color:var(--icecream-primary)]/5 p-4">
      <p className="flex items-center gap-2 text-sm font-semibold text-[color:var(--icecream-primary)]">
        <span aria-hidden="true" className="text-lg">💡</span>
        {payload.uiCopy?.bannerTitle ?? "Better Value Suggestion"}
      </p>
      <div className="mt-3 flex flex-col gap-4 sm:flex-row">
        <CardImage src={payload.toProduct.imageUrl} alt={payload.toProduct.name} className="h-32 sm:w-40" />
        <div className="flex-1 space-y-1 text-sm">
          <p className="text-base font-semibold">{payload.toProduct.headline}</p>
          <p className="text-black/70">{payload.toProduct.subline}</p>
          <p className="text-xs text-black/60">
            Difference: {formatDirham(payload.priceDiffAED)} · Estimated savings: {formatDirham(payload.savingsEstimateAED)}
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold">
        <ActionPill label={primaryLabel} />
        <ActionPill label={secondaryLabel} minimal />
      </div>
    </div>
  );
}

function SizeOptions({ sizeOptions }: { sizeOptions?: SizeOption[] }) {
  if (!sizeOptions?.length) {
    return null;
  }
  return (
    <div className="space-y-2 rounded-[28px] border border-black/5 bg-white/95 p-4">
      <p className="text-sm font-semibold">Size Options</p>
      <div className="flex flex-wrap items-center gap-3 text-sm font-semibold text-black/70">
        {sizeOptions.map((option, index) => (
          <div key={option.id ?? option.size} className="flex items-center gap-2">
            {index > 0 ? <span className="text-black/30">|</span> : null}
            <span>{option.size ?? "Size"}</span>
            {typeof option.priceAED === "number" ? <span className="text-xs text-black/50">{formatDirham(option.priceAED)}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}
function HeaderBar({ cartIndicator, subtitle, showBack }: { cartIndicator?: CartIndicator; subtitle?: string; showBack?: boolean }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        {showBack ? (
          <span className="inline-flex items-center rounded-full border border-black/10 px-3 py-1 text-xs font-semibold text-black/60">? All Items</span>
        ) : (
          <div className="rounded-full bg-[color:var(--icecream-primary)]/15 px-3 py-1 text-sm font-semibold text-[color:var(--icecream-primary)]">BR</div>
        )}
        <div>
          <p className="text-base font-semibold text-[color:var(--icecream-dark)]">Baskin Robbins Al Quoz</p>
          {subtitle ? <p className="text-xs text-black/60">{subtitle}</p> : null}
        </div>
      </div>
      {cartIndicator ? (
        <div className="text-sm font-semibold text-[color:var(--icecream-primary)]">
          Cart ({cartIndicator.count}) | {formatDirham(cartIndicator.total)}
        </div>
      ) : null}
    </div>
  );
}
function OverlaySectionHeader({ title, subtitle, showBack }: { title: string; subtitle?: string | null; showBack?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--icecream-primary)]">{subtitle ?? "On screen"}</p>
        <h3 className="text-xl font-semibold text-[color:var(--icecream-dark)]">{title}</h3>
      </div>
      {showBack ? <span className="inline-flex items-center rounded-full border border-black/10 px-3 py-1 text-xs font-semibold text-black/60">? Back</span> : null}
    </div>
  );
}
function FilterBadge({ label }: { label: string }) {
  return <span className="rounded-full bg-black/5 px-3 py-1 text-black/60">{label}</span>;
}

function ActionPill({ label, minimal }: { label: string; minimal?: boolean }) {
  return (
    <button
      type="button"
      className={clsx(
        "rounded-full px-3 py-1",
        minimal ? "border border-black/10 text-black/60" : "bg-[color:var(--icecream-primary)] text-black"
      )}
    >
      {label}
    </button>
  );
}
function QuantityBadge({ value = 1 }: { value?: number }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-black/10 px-3 py-1 text-xs font-semibold text-black">
      – {value} +
    </span>
  );
}

function SelectionSummary({
  title,
  summary,
  items,
  emptyLabel,
  actionLabel,
}: {
  title: string;
  summary?: SummaryNote;
  items?: (FlavorSelection | ToppingSelection)[];
  emptyLabel: string;
  actionLabel: string;
}) {
  return (
    <div className="space-y-2 rounded-[28px] border border-black/5 bg-white/95 p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--icecream-primary)]">{title}</p>
          <p className="text-sm text-black/70">{summary?.label ?? ""}</p>
          {summary?.extraNote ? <p className="text-xs text-black/60">{summary.extraNote}</p> : null}
        </div>
        <ActionPill label={actionLabel} minimal />
      </div>
      <div className="flex flex-wrap gap-2">
        {items?.length ? (
          items.map((item) => (
            <span
              key={item.id ?? item.name}
              className="rounded-full bg-[color:var(--icecream-primary)] px-3 py-1 text-xs font-medium text-white shadow-sm"
            >
              {item.name}
            </span>
          ))
        ) : (
          <span className="text-xs text-black/50">{emptyLabel}</span>
        )}
      </div>
    </div>
  );
}

function ToppingPriceGroup({ title, items, selectedIds }: { title: string; items: ToppingCatalogCard[]; selectedIds: Set<string> }) {
  if (!items.length) {
    return null;
  }
  return (
    <div className="space-y-2">
      <p className="text-sm font-semibold">{title}</p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-2">
        {items.map((item) => {
          const selected = selectedIds.has(item.id ?? "");
          return (
            <article
              key={item.id ?? item.name}
              className={clsx(
                "flex flex-col rounded-3xl border border-black/5 bg-white/95 p-4 text-center shadow-sm transition-all cursor-pointer hover:shadow-md",
                selected && "border-[color:var(--icecream-primary)] shadow-[0_8px_20px_rgba(255,86,162,0.2)]"
              )}
            >
              <CardImage src={item.imageUrl} alt={item.name} className="h-32 bg-white" contain />
              <div className="mt-3 space-y-1">
                <p className="text-base font-semibold text-[color:var(--icecream-dark)]">{item.name}</p>
                <p className="text-sm text-black/60">{formatDirham(item.priceAED)}</p>
              </div>
              {selected && (
                <div className="mt-3 flex items-center justify-center">
                  <span className="inline-flex items-center gap-1 text-sm font-semibold text-[color:var(--icecream-primary)]">
                    <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                    </svg>
                    Selected
                  </span>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function CartFlavorList({ flavors }: { flavors?: CartFlavor[] }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--icecream-primary)]">Flavors</p>
      {flavors?.length ? (
        <div className="space-y-2">
          {flavors.map((flavor) => (
            <CartSelectionRow
              key={flavor.id ?? flavor.name}
              image={flavor.imageUrl}
              name={flavor.name}
              descriptor={flavor.isExtra ? "Extra flavor" : "Included"}
              qty={flavor.qty}
              price={resolveLinePrice(flavor)}
            />
          ))}
        </div>
      ) : (
        <p className="text-xs text-black/50">No flavors selected.</p>
      )}
    </div>
  );
}

function CartToppingList({ toppings }: { toppings?: CartTopping[] }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--icecream-primary)]">Toppings</p>
      {toppings?.length ? (
        <div className="space-y-2">
          {toppings.map((topping) => (
            <CartSelectionRow
              key={topping.id ?? topping.name}
              image={topping.imageUrl}
              name={topping.name}
              descriptor={topping.isFree ? "Included" : "Charged add-on"}
              qty={topping.qty}
              price={topping.isFree ? 0 : resolveLinePrice(topping)}
            />
          ))}
        </div>
      ) : (
        <p className="text-xs text-black/50">No toppings added.</p>
      )}
    </div>
  );
}

function CartSelectionRow({
  image,
  name,
  descriptor,
  qty,
  price,
}: {
  image?: string | null;
  name?: string;
  descriptor: string;
  qty?: number | null;
  price?: number | null;
}) {
  return (
    <div className="flex items-center gap-3 rounded-2xl bg-black/5 p-2">
      <div className="h-12 w-12 shrink-0">
        <CardImage src={image} alt={name} className="h-12 w-12 bg-white" contain />
      </div>
      <div className="flex-1">
        <p className="text-sm font-semibold text-black/80">{name ?? "Selection"}</p>
        <p className="text-xs text-black/60">
          Qty {qty ?? 1} · {descriptor}
        </p>
      </div>
      <div className="text-sm font-semibold text-black/80">{formatDirham(price ?? 0)}</div>
    </div>
  );
}

function CardImage({ src, alt, className, contain }: { src?: string | null; alt?: string | null; className?: string; contain?: boolean }) {
  if (!src) {
    return <div className={clsx("flex items-center justify-center rounded-2xl bg-black/5 text-sm text-black/40", className)}>Image</div>;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt ?? "Image"}
      className={clsx(
        "w-full rounded-2xl",
        contain ? "object-contain bg-white p-2" : "object-cover",
        className
      )}
    />
  );
}

function buildScoopsDots(free: number, selected: number) {
  const total = Math.max(free, selected, 1);
  return Array.from({ length: total }).map((_, index) => (
    <span key={`scoop-${index}`} className={clsx("inline-block h-3 w-3 rounded-full", index < selected ? "bg-[color:var(--icecream-primary)]" : "bg-black/20")}></span>
  ));
}

function resolveLinePrice(entry?: { linePriceAED?: number | null; unitPriceAED?: number | null; qty?: number | null }) {
  if (!entry) {
    return 0;
  }
  if (typeof entry.linePriceAED === "number") {
    return entry.linePriceAED;
  }
  const qty = entry.qty ?? 1;
  const unit = entry.unitPriceAED ?? 0;
  return unit * qty;
}

function formatDirham(value?: number | null) {
  if (typeof value === "number" && !Number.isNaN(value)) {
    return `${value.toFixed(2)} dirham`;
  }
  return "0.00 dirham";
}


