"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { isDialogBackdropClick } from "@/components/ui/dialog-backdrop";
import type { BentoBox } from "@/domain/inspiration-layout";
import { Icon } from "@/components/ui/icon";
import {
  inspirationPartLabels,
  partLiked,
  togglePart,
  toggleWhole,
  type InspirationBrand,
  type InspirationPart,
  type InspirationPartImage,
  type InspirationPreferences,
} from "@/domain/inspiration";

/** A brand's saved choice and how to change it. Liking the whole brand and
 * liking each of its images are independent. */
export type BrandLikes = {
  choice: InspirationPreferences;
  disabled: boolean;
  status?: ReactNode;
  onChange: (next: InspirationPreferences) => void;
};

export function Heart({ liked }: { liked: boolean }) {
  return (
    <svg
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill={liked ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" />
    </svg>
  );
}
function LikeButton({
  liked,
  label,
  disabled,
  className = "inspiration-heart",
  onToggle,
}: {
  liked: boolean;
  label: string;
  disabled: boolean;
  className?: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={className}
      aria-pressed={liked}
      aria-label={label}
      disabled={disabled}
      onClick={onToggle}
    >
      <Heart liked={liked} />
    </button>
  );
}
const partLabel = (part: InspirationPart) => inspirationPartLabels[part].toLowerCase();
// A heart's name stays "Like …"; whether it is liked is its pressed state, so it is never "Unlike …, pressed".
const wholeLabel = (brand: InspirationBrand) => `Like the whole ${brand.brand} brand`;
const partLikeLabel = (brand: InspirationBrand, part: InspirationPart) => `Like ${brand.brand} ${partLabel(part)}`;

// Reference artwork served as is from public/inspiration/brands.
function BrandImage({
  image,
  size,
  eager = false,
  inButton = false,
}: {
  image: InspirationPartImage;
  size: "small" | "large";
  eager?: boolean;
  /** Drawn inside the tile's open button: a failed image shows no Retry of its own (no button inside a button);
   * opening the brand loads it again in the large view, which has Retry. */
  inButton?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  if (failed && inButton)
    return (
      <span className="inspiration-image-error">
        <Icon name="assets" />
        <span>Image unavailable</span>
      </span>
    );
  if (failed)
    return (
      <span className="inspiration-image-error">
        <Icon name="assets" />
        <span>Image unavailable</span>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setFailed(false);
          }}
        >
          Retry image
        </button>
      </span>
    );
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={size === "small" ? image.thumbnail : image.image}
      width={image.width}
      height={image.height}
      alt={image.description}
      loading={eager ? "eager" : "lazy"}
      onError={() => setFailed(true)}
    />
  );
}

/** One brand's container: its name and a heart for the whole brand, then each
 * image in a container of its own, in rows that keep every image's shape, with a
 * heart for that part. Clicking anywhere but a heart opens the brand. In the
 * bento, box places and sizes the card; without it the card sizes itself. */
export function BrandCard({
  brand,
  rows,
  box,
  likes,
  onOpen,
}: {
  brand: InspirationBrand;
  rows: readonly (readonly InspirationPartImage[])[];
  box?: BentoBox;
  likes: BrandLikes;
  onOpen: (part?: InspirationPart) => void;
}) {
  const { choice } = likes;
  return (
    <article
      className="inspiration-brand"
      aria-label={brand.brand}
      style={box ? { position: "absolute", left: box.x, top: box.y, width: box.width, height: box.height } : undefined}
      onClick={(event) => {
        if (!(event.target as Element).closest("button")) onOpen();
      }}
    >
      <header className="inspiration-brand-header">
        <button type="button" className="inspiration-brand-title" onClick={() => onOpen()}>
          <strong>{brand.brand}</strong>
          <span>Open brand</span>
        </button>
        {likes.status}
        <LikeButton
          className="inspiration-heart inspiration-brand-like"
          liked={choice.ensemble}
          label={wholeLabel(brand)}
          disabled={likes.disabled}
          onToggle={() => likes.onChange(toggleWhole(choice))}
        />
      </header>
      <div className="inspiration-brand-bento">
        {rows.map((row) => (
          <div key={row[0]!.part} className="inspiration-brand-row">
            {row.map((image) => {
              const liked = partLiked(choice, image.part);
              return (
                <div
                  key={image.part}
                  className="inspiration-brand-tile"
                  data-part={image.part}
                  style={{
                    flex: `${image.width / image.height} 1 0px`,
                    aspectRatio: `${image.width} / ${image.height}`,
                    backgroundColor: image.fill,
                  }}
                >
                  <button
                    type="button"
                    className="inspiration-brand-open"
                    aria-label={`Open ${brand.brand}: ${partLabel(image.part)}`}
                    onClick={() => onOpen(image.part)}
                  >
                    <BrandImage image={image} size="small" inButton />
                  </button>
                  <span className="inspiration-tile-label" aria-hidden="true">
                    {inspirationPartLabels[image.part]}
                  </span>
                  <LikeButton
                    className="inspiration-heart inspiration-part-like"
                    liked={liked}
                    label={partLikeLabel(brand, image.part)}
                    disabled={likes.disabled}
                    onToggle={() => likes.onChange(togglePart(choice, image.part))}
                  />
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </article>
  );
}

/** One part of one brand, in a category such as Logos or Colors. */
export function PartCard({
  brand,
  image,
  likes,
  onOpen,
}: {
  brand: InspirationBrand;
  image: InspirationPartImage;
  likes: BrandLikes;
  onOpen: () => void;
}) {
  const liked = partLiked(likes.choice, image.part);
  return (
    <article className="inspiration-card" aria-label={`${brand.brand} ${partLabel(image.part)}`}>
      <div className="inspiration-card-art">
        <button
          type="button"
          className="inspiration-open"
          aria-label={`Open ${brand.brand}: ${partLabel(image.part)}`}
          onClick={onOpen}
        >
          <BrandImage image={image} size="small" inButton />
        </button>
        <LikeButton
          liked={liked}
          label={partLikeLabel(brand, image.part)}
          disabled={likes.disabled}
          onToggle={() => likes.onChange(togglePart(likes.choice, image.part))}
        />
      </div>
      <button className="inspiration-caption" type="button" onClick={onOpen}>
        <strong>{brand.brand}</strong>
      </button>
      {likes.status}
    </article>
  );
}

/** A large overlay with every image of one brand: the selected image on the
 * left, and on the right the brand, its likes and all five parts. */
export function BrandOverlay({
  brand,
  initialPart,
  likes,
  footer,
  onClose,
}: {
  brand: InspirationBrand;
  initialPart?: InspirationPart;
  likes: BrandLikes;
  footer: ReactNode;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    titleId = useId();
  const [part, setPart] = useState<InspirationPart>(initialPart ?? brand.parts[0]!.part);
  useEffect(() => {
    const element = dialog.current,
      previous = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  const index = Math.max(
      0,
      brand.parts.findIndex((item) => item.part === part),
    ),
    image = brand.parts[index]!;
  const step = (delta: number) => setPart(brand.parts[(index + delta + brand.parts.length) % brand.parts.length]!.part);
  const { choice } = likes;
  return (
    <dialog
      ref={dialog}
      className="inspiration-detail inspiration-brand-overlay"
      aria-labelledby={titleId}
      onCancel={onClose}
      onClick={(event) => {
        if (isDialogBackdropClick(event)) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          event.preventDefault();
          step(event.key === "ArrowLeft" ? -1 : 1);
        }
      }}
    >
      <div className="inspiration-detail-layout">
        <figure className="inspiration-detail-art inspiration-overlay-art">
          <BrandImage key={image.part} image={image} size="large" eager />
          <figcaption aria-live="polite" aria-atomic="true">
            {inspirationPartLabels[image.part]} · {index + 1} of {brand.parts.length}
          </figcaption>
          <button
            type="button"
            className="inspiration-overlay-step"
            data-direction="previous"
            aria-label="Previous image"
            onClick={() => step(-1)}
          >
            <Icon name="arrow" size={18} />
          </button>
          <button
            type="button"
            className="inspiration-overlay-step"
            data-direction="next"
            aria-label="Next image"
            onClick={() => step(1)}
          >
            <Icon name="arrow" size={18} />
          </button>
        </figure>
        <div className="inspiration-detail-body">
          <div className="inspiration-detail-top">
            <span>BRAND</span>
            <button
              autoFocus
              type="button"
              className="inspiration-icon-button"
              aria-label="Close brand"
              onClick={onClose}
            >
              <Icon name="close" size={18} />
            </button>
          </div>
          <h2 id={titleId}>{brand.brand}</h2>
          <p>{brand.description}</p>
          <button
            className="inspiration-overall"
            type="button"
            aria-pressed={choice.ensemble}
            aria-label={wholeLabel(brand)}
            disabled={likes.disabled}
            onClick={() => likes.onChange(toggleWhole(choice))}
          >
            <Heart liked={choice.ensemble} />
            Whole brand
          </button>
          <hr />
          <h3>Or like just a part</h3>
          <ul className="inspiration-overlay-parts">
            {brand.parts.map((item) => {
              const liked = partLiked(choice, item.part);
              return (
                <li key={item.part}>
                  <button
                    type="button"
                    className="inspiration-overlay-part"
                    aria-current={item.part === part}
                    onClick={() => setPart(item.part)}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={item.thumbnail} width={item.width} height={item.height} alt="" loading="lazy" />
                    <span>{inspirationPartLabels[item.part]}</span>
                  </button>
                  <LikeButton
                    className="inspiration-heart inspiration-overlay-like"
                    liked={liked}
                    label={partLikeLabel(brand, item.part)}
                    disabled={likes.disabled}
                    onToggle={() => likes.onChange(togglePart(choice, item.part))}
                  />
                </li>
              );
            })}
          </ul>
          {likes.status}
          {footer}
        </div>
      </div>
    </dialog>
  );
}
