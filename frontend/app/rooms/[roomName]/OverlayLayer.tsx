
"use client";

import type { ReactNode } from "react";
import { useCallback, useMemo, useState } from "react";
import { useDataChannel } from "@livekit/components-react";
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
};

type CartFlavor = { id?: string; name?: string };

type CartTopping = { id?: string; name?: string; isFree?: boolean; priceAED?: number | null };

type CartItem = {
  lineId?: string;
  product_id?: string;
  name?: string;
  category?: string;
  size?: string | null;
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
};

type ClearOverlayPayload = { kind: "clear" };

type ProductsOverlayPayload = ProductGridPayload | ProductDetailPayload;

type OverlayPayload =
  | ProductsOverlayPayload
  | FlavorOverlayPayload
  | ToppingOverlayPayload
  | CartOverlayPayload
  | DirectionsOverlayPayload
  | UpgradeOverlayPayload
  | ClearOverlayPayload
  | { kind: string };

type OverlayLayerKind = "products" | "flavors" | "toppings" | "cart" | "directions";

type CartIndicator = { count: number; total: number };

const decoder = new TextDecoder();
const OVERLAY_TOPIC = "ui.overlay";
const CATEGORY_OPTIONS = ["All", "Cups", "Sundae Cups", "Milk Shakes"];
const FLAVOR_TABS = ["All", "Choco", "Berry", "Classics", "SugarLess"];
export function OverlayLayer() {
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
    },
    []
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
      (msg) => {
        if (msg?.payload) {
          handleOverlayPacket(msg.payload);
        }
      },
      [handleOverlayPacket]
    )
  );

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

  let overlayBody: ReactNode = null;

  if (activeLayer === "cart" && cartPayload?.cart) {
    overlayBody = (
      <div className="flex w-full max-w-[1400px] justify-end">
        <div className="w-full max-w-[420px] rounded-[28px] border border-black/5 bg-white/95 p-4 shadow-2xl">
          <CartOverlay payload={cartPayload.cart} />
        </div>
      </div>
    );
  } else if (activeLayer === "directions" && directionsPayload) {
    overlayBody = (
      <div className="flex w-full max-w-[1400px] justify-end">
        <div className="w-full max-w-[420px] rounded-[28px] border border-black/5 bg-white/95 p-4 shadow-2xl">
          <DirectionsOverlay payload={directionsPayload} />
        </div>
      </div>
    );
  } else if (panelContent && detailElement) {
    overlayBody = (
      <div className="flex w-full max-w-[1400px] flex-col gap-4 pl-6 lg:flex-row lg:items-start lg:justify-start">
        <div className="w-full max-w-[520px] rounded-[32px] border border-black/5 bg-white/95 p-4 shadow-2xl">{detailElement}</div>
        <div className="w-full max-w-[340px] rounded-[32px] border border-black/5 bg-white/95 p-4 shadow-2xl">{panelContent}</div>
      </div>
    );
  } else if (showMenuColumn && detailElement && menuCache) {
    overlayBody = (
      <div className="flex w-full max-w-[1400px] flex-col gap-4 pl-6 lg:flex-row lg:items-start lg:justify-start">
        <div className="w-full max-w-[520px] rounded-[32px] border border-black/5 bg-white/95 p-4 shadow-2xl">
          <ProductGridOverlay payload={menuCache} cartIndicator={cartIndicator} compact />
        </div>
        <div className="w-full max-w-[520px] rounded-[32px] border border-black/5 bg-white/95 p-4 shadow-2xl">{detailElement}</div>
      </div>
    );
  } else if (detailElement) {
    overlayBody = (
      <div className="flex w-full max-w-[1200px] justify-start pl-6">
        <div className="w-full max-w-[560px] rounded-[32px] border border-black/5 bg-white/95 p-4 shadow-2xl">{detailElement}</div>
      </div>
    );
  } else if (gridElement) {
    overlayBody = (
      <div className="flex w-full max-w-[1200px] justify-start pl-6">
        <div className="w-full max-w-[640px] rounded-[32px] border border-black/5 bg-white/95 p-4 shadow-2xl">{gridElement}</div>
      </div>
    );
  } else if (panelContent) {
    overlayBody = (
      <div className="flex w-full max-w-[1400px] justify-end">
        <div className="w-full max-w-[340px] rounded-[32px] border border-black/5 bg-white/95 p-4 shadow-2xl">{panelContent}</div>
      </div>
    );
  }

  if (!overlayBody) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 py-8 sm:px-6">
      <div className="pointer-events-auto w-full">{overlayBody}</div>
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
              (payload.category ?? "All") === category ? "bg-[color:var(--icecream-primary)] text-white" : "bg-black/5 text-black/60"
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
                <button
                  type="button"
                  className="mt-3 inline-flex items-center justify-center rounded-full border border-[color:var(--icecream-primary)] px-3 py-1 text-xs font-semibold text-[color:var(--icecream-primary)]"
                >
                  View Details
                </button>
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
        <div className="flex flex-col gap-6 lg:flex-row">
          <div className="w-full lg:w-1/3">
            <CardImage src={product?.imageUrl} alt={product?.name} className="h-60" />
          </div>
          <div className="flex-1 space-y-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--icecream-primary)]">{product?.category}</p>
              <h2 className="text-2xl font-semibold">{product?.name ?? "Treat"}</h2>
              <p className="text-sm text-black/60">
                Size: {product?.size ?? "—"}
                {typeof product?.scoops === "number" ? ` · ${product?.scoops} scoop${product?.scoops === 1 ? "" : "s"}` : null}
              </p>
              {product.display ? <p className="text-xs text-black/60">Pickup: {product.display}</p> : null}
            </div>
            <div className="rounded-2xl bg-black/5 px-4 py-3 text-sm font-semibold text-[color:var(--icecream-primary)]">
              Base: {formatDirham(product?.priceAED)}
            </div>
            <div className="rounded-2xl bg-black/5 px-4 py-3 text-xs text-black/70">
              Free Flavors: {product?.scoops ?? 0}
              <br />
              Free Toppings: {product?.includedToppings ?? 0}
            </div>
            <div className="flex flex-wrap gap-2 text-xs">
              <ActionPill label="Choose Flavors" />
              <ActionPill label="Add Toppings" />
            </div>
            <div className="flex items-center gap-3 text-sm font-semibold">
              Quantity:
              <QuantityBadge />
              <button type="button" className="rounded-full bg-[color:var(--icecream-primary)] px-4 py-2 text-sm font-semibold text-white">
                Add to Cart
              </button>
            </div>
          </div>
        </div>
      </div>
      <SelectionSummary
        title="Selected Flavors"
        summary={payload.flavorSummary}
        items={payload.selectedFlavors}
        emptyLabel="Flavors will appear here after selection."
        actionLabel="Change Flavors"
      />
      <SelectionSummary
        title="Selected Toppings"
        summary={payload.toppingSummary}
        items={payload.selectedToppings}
        emptyLabel="Toppings will appear here after selection."
        actionLabel="Change Toppings"
      />
      {upgrade?.show ? <UpgradeBanner payload={upgrade} /> : null}
      <SizeOptions sizeOptions={payload.sizeOptions} />
    </div>
  );
}

function FlavorsOverlay({ payload }: { payload: FlavorOverlayPayload }) {
  const selectedCount = payload.selectedFlavorIds?.length ?? payload.selectedFlavors?.length ?? 0;
  const dots = buildScoopsDots(payload.freeFlavors ?? 0, selectedCount);
  return (
    <div className="space-y-3">
      <OverlaySectionHeader title="Choose Your Flavors" subtitle={payload.productName} />
      <div className="flex items-center gap-2 text-sm font-semibold text-black/70">
        <span>Scoops available:</span>
        <div className="flex items-center gap-1">{dots}</div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-wide text-black/60">
        {FLAVOR_TABS.map((tab) => (
          <span
            key={tab}
            className={clsx(
              "rounded-full px-3 py-1",
              tab === "All" ? "bg-[color:var(--icecream-primary)] text-white" : "bg-black/5 text-black/50"
            )}
          >
            {tab}
          </span>
        ))}
      </div>
      <div className="max-h-[50vh] overflow-y-auto pr-2">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(payload.flavors ?? []).map((flavor) => {
            const selected = payload.selectedFlavorIds?.includes(flavor.id ?? "");
            return (
              <article
                key={flavor.id ?? flavor.name}
                className={clsx(
                  "rounded-2xl border px-3 py-4 text-center",
                  selected ? "border-[color:var(--icecream-primary)] bg-[color:var(--icecream-primary)]/5" : "border-black/5"
                )}
              >
                <CardImage src={flavor.imageUrl} alt={flavor.name} className="h-28 bg-white" contain />
                <p className="mt-2 text-sm font-semibold">{flavor.name}</p>
                <p className="text-[10px] uppercase tracking-wide text-black/50">{flavor.classification ?? ""}</p>
                <button
                  type="button"
                  className={clsx(
                    "mt-2 inline-flex items-center justify-center rounded-full px-3 py-1 text-xs font-semibold",
                    selected ? "bg-[color:var(--icecream-primary)] text-white" : "bg-black/10 text-black/70"
                  )}
                >
                  {selected ? "Selected" : "Select"}
                </button>
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
  return (
    <div className="space-y-3">
      <OverlaySectionHeader title="Add Toppings" subtitle={payload.note ?? payload.productName} />
      <div className="rounded-2xl bg-black/5 px-4 py-3 text-xs text-black/70">
        Free toppings remaining: {payload.freeToppingsRemaining ?? 0}
      </div>
      <ToppingPriceGroup title="Toppings – 5 dirham" items={groupFive} selectedIds={selectedIds} />
      <ToppingPriceGroup title="Toppings – 6 dirham" items={groupSix} selectedIds={selectedIds} />
      <div className="flex items-center justify-between rounded-2xl bg-black/5 px-4 py-3 text-xs text-black/70">
        <span>
          Selected: {payload.selectedToppings?.map((topping) => topping.name).filter(Boolean).join(", ") || "None"}
        </span>
        <span>
          Free: {(payload.freeToppings ?? 0) - (payload.freeToppingsRemaining ?? 0)} · Extra: {Math.max((payload.selectedToppings?.length ?? 0) - (payload.freeToppings ?? 0), 0)}
        </span>
      </div>
      <div className="flex items-center justify-end gap-2">
        <ActionPill label="Clear" minimal />
        <ActionPill label="Confirm" />
      </div>
    </div>
  );
}

function CartOverlay({ payload }: { payload: NonNullable<CartOverlayPayload["cart"]> }) {
  const items = payload.items ?? [];
  return (
    <div className="space-y-4">
      <OverlaySectionHeader title="Your Cart" subtitle="Everything ready for pickup" showBack />
      {items.length === 0 ? (
        <div className="rounded-3xl bg-white/90 p-6 text-center text-sm text-black/60">Cart is empty for now.</div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <article key={item.lineId ?? item.product_id ?? item.name} className="space-y-2 rounded-3xl border border-black/5 bg-white/95 p-4 shadow-sm">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-base font-semibold">{item.name}</p>
                  <p className="text-xs text-black/60">{item.category}</p>
                </div>
                <div className="text-sm font-semibold text-[color:var(--icecream-primary)]">{formatDirham(item.lineTotalAED)}</div>
              </div>
              <p className="text-xs text-black/60">Size: {item.size ?? "—"}</p>
              {item.flavors?.length ? (
                <p className="text-xs text-black/60">Flavours: {item.flavors.map((flavor) => flavor.name).filter(Boolean).join(", ")}</p>
              ) : null}
              {item.toppings?.length ? (
                <p className="text-xs text-black/60">Toppings: {item.toppings.map((topping) => topping.name).filter(Boolean).join(", ")}</p>
              ) : null}
              <div className="flex items-center gap-3 text-xs text-black/60">
                Qty:
                <QuantityBadge value={item.qty ?? 1} />
              </div>
            </article>
          ))}
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
        <OverlaySectionHeader title="Pickup Instructions" subtitle={`Location: ${location.displayName ?? "—"}`} showBack />
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
          <article key={location.displayName ?? index} className="rounded-2xl border border-black/5 bg-white/95 p-4 shadow-sm">
            <p className="text-sm font-semibold">Step {index + 1} – {location.displayName}</p>
            {location.products?.length ? (
              <p className="text-xs text-black/60">Collect: {location.products.join(", ")}</p>
            ) : null}
            <p className="text-xs text-black/60">Hint: {location.hint ?? "Look for Scoop signage."}</p>
            {location.mapImage ? (
              <a
                href={location.mapImage}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center text-xs font-semibold text-[color:var(--icecream-primary)]"
              >
                View Photo
              </a>
            ) : null}
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
  return (
    <div className="rounded-[28px] border border-dashed border-[color:var(--icecream-primary)] bg-[color:var(--icecream-primary)]/5 p-4">
      <p className="text-sm font-semibold text-[color:var(--icecream-primary)]">
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
        <ActionPill label={payload.uiCopy?.primaryCtaLabel ?? "Upgrade"} />
        <ActionPill label={payload.uiCopy?.secondaryCtaLabel ?? "Keep Current Choice"} minimal />
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
      <div className="flex flex-wrap gap-2">
        {sizeOptions.map((option) => (
          <span key={option.id ?? option.size} className="rounded-full border border-black/10 px-3 py-1 text-xs font-semibold">
            {option.size ?? "Size"} · {formatDirham(option.priceAED)}
          </span>
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
          <span className="rounded-full bg-black/5 px-3 py-1 text-xs font-semibold text-black/60">←</span>
        ) : (
          <div className="rounded-full bg-[color:var(--icecream-primary)]/15 px-3 py-1 text-sm font-semibold text-[color:var(--icecream-primary)]">BR</div>
        )}
        <div>
          <p className="text-base font-semibold">Baskin Robbins Al Quoz</p>
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
        <h3 className="text-xl font-semibold">{title}</h3>
      </div>
      {showBack ? <span className="rounded-full bg-black/5 px-3 py-1 text-xs font-semibold text-black/60">← Back</span> : null}
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
        minimal ? "border border-black/10 text-black/60" : "bg-[color:var(--icecream-primary)] text-white"
      )}
    >
      {label}
    </button>
  );
}

function QuantityBadge({ value = 1 }: { value?: number }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-black/10 px-3 py-1 text-xs font-semibold">
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
            <span key={item.id ?? item.name} className="rounded-full bg-black/5 px-3 py-1 text-xs">
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
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => {
          const selected = selectedIds.has(item.id ?? "");
          return (
            <article
              key={item.id ?? item.name}
              className={clsx(
                "rounded-2xl border px-3 py-4 text-center",
                selected ? "border-[color:var(--icecream-primary)] bg-[color:var(--icecream-primary)]/5" : "border-black/5"
              )}
            >
              <CardImage src={item.imageUrl} alt={item.name} className="h-28 bg-white" contain />
              <p className="mt-2 text-sm font-semibold">{item.name}</p>
              <p className="text-xs text-black/60">{formatDirham(item.priceAED)}</p>
              <button
                type="button"
                className={clsx(
                  "mt-2 inline-flex items-center justify-center rounded-full px-3 py-1 text-xs font-semibold",
                  selected ? "bg-[color:var(--icecream-primary)] text-white" : "bg-black/10 text-black/70"
                )}
              >
                {selected ? "Selected" : "Select"}
              </button>
            </article>
          );
        })}
      </div>
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

function formatDirham(value?: number | null) {
  if (typeof value === "number" && !Number.isNaN(value)) {
    return `${value.toFixed(2)} dirham`;
  }
  return "0.00 dirham";
}

