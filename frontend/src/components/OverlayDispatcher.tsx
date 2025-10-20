import React from "react";

export type Product = {
  id: string;
  name: string;
  description?: string;
  priceCents: number;
  imageUrl?: string;
  displayName?: string;
};

export type OverlayPayload =
  | { kind: "products"; items: Product[]; speak?: string }
  | {
      kind: "cart";
      summary: string;
      items: Array<{ id: string; name: string; qty: number; priceCents: number }>;
    }
  | { kind: "directions"; label: string; hint?: string; steps?: string[]; mapImageUrl?: string }
  | { kind: "checkout"; amountCents: number; receiptUrl?: string; note?: string };

export type OverlayMessage = { type: "ui.overlay"; payload: OverlayPayload } | null;

const currency = (amountCents: number) => {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(amountCents / 100);
};

const Card: React.FC<React.PropsWithChildren<{ className?: string }>> = ({
  className,
  children,
}) => (
  <div className={`overlay-card ${className ?? ""}`.trim()}>{children}</div>
);

export const OverlayDispatcher: React.FC<{ message: OverlayMessage }> = ({ message }) => {
  if (!message) return null;
  const { payload } = message;

  switch (payload.kind) {
    case "products":
      return <ProductsOverlay {...payload} />;
    case "cart":
      return <CartOverlay {...payload} />;
    case "directions":
      return <DirectionsOverlay {...payload} />;
    case "checkout":
      return <CheckoutOverlay {...payload} />;
    default:
      return null;
  }
};

const ProductsOverlay: React.FC<{ items: Product[]; speak?: string }> = ({ items, speak }) => (
  <Card className="overlay-card--products">
    {speak ? <p className="overlay-products__hint">{speak}</p> : null}
    <div className="overlay-products__grid">
      {items.slice(0, 6).map((product) => (
        <article key={product.id} className="overlay-products__item">
          {product.imageUrl ? (
            <img src={product.imageUrl} alt={product.name} className="overlay-products__image" />
          ) : (
            <div className="overlay-products__image overlay-products__image--placeholder" />
          )}
          <div className="overlay-products__content">
            <h3>{product.name}</h3>
            {product.description ? <p>{product.description}</p> : null}
            <div className="overlay-products__meta">
              <span>{product.displayName ?? "Ask for location"}</span>
              <strong>{currency(product.priceCents)}</strong>
            </div>
          </div>
        </article>
      ))}
    </div>
  </Card>
);

const CartOverlay: React.FC<{
  summary: string;
  items: Array<{ id: string; name: string; qty: number; priceCents: number }>;
}> = ({ summary, items }) => {
  const total = items.reduce((acc, item) => acc + item.qty * item.priceCents, 0);
  return (
    <Card>
      <p className="overlay-cart__summary">{summary}</p>
      <ul className="overlay-cart__list">
        {items.map((item) => (
          <li key={item.id}>
            <span>
              {item.name} × {item.qty}
            </span>
            <strong>{currency(item.qty * item.priceCents)}</strong>
          </li>
        ))}
      </ul>
      <div className="overlay-cart__total">
        <span>Subtotal</span>
        <strong>{currency(total)}</strong>
      </div>
    </Card>
  );
};

const DirectionsOverlay: React.FC<{
  label: string;
  hint?: string;
  steps?: string[];
  mapImageUrl?: string;
}> = ({ label, hint, steps, mapImageUrl }) => (
  <Card>
    <h3 className="overlay-directions__title">Pickup: {label}</h3>
    {hint ? <p className="overlay-directions__hint">{hint}</p> : null}
    {mapImageUrl ? <img src={mapImageUrl} alt={`Map to ${label}`} className="overlay-directions__image" /> : null}
    {steps?.length ? (
      <ol className="overlay-directions__steps">
        {steps.map((step, idx) => (
          <li key={idx}>{step}</li>
        ))}
      </ol>
    ) : null}
  </Card>
);

const CheckoutOverlay: React.FC<{ amountCents: number; receiptUrl?: string; note?: string }> = ({
  amountCents,
  receiptUrl,
  note,
}) => (
  <Card>
    <h3 className="overlay-checkout__title">Total: {currency(amountCents)}</h3>
    {note ? <p className="overlay-checkout__note">{note}</p> : null}
    {receiptUrl ? (
      <a href={receiptUrl} target="_blank" rel="noreferrer" className="overlay-checkout__link">
        View receipt
      </a>
    ) : null}
  </Card>
);
