"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { brandBoardContrastRatio as contrast } from "@/domain/brand-board-design";
import { brandBoardFont } from "@/domain/brand-board-fonts";
import { guidedSlogan } from "@/domain/guided-interview";
import type { ContextSnapshot } from "@/domain/projects";
import { Button, buttonClass, Spinner } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { MediaFrame, type MediaRatio } from "@/components/ui/media-frame";
import { Menu } from "@/components/ui/menu";
import { InlineMessage } from "@/components/ui/message";
import { useToast } from "@/components/ui/toast";
import type { BrandAssetFile, PreparedBrandAssets } from "../client/build-pack";
import { BRAND_APPLICATIONS } from "../model/artwork";
import {
  designTokens,
  designTokensCss,
  designTokensJson,
  readableBrandColor,
  TYPE_SCALE,
} from "../model/design-tokens";
import type { BrandAssetSnapshot } from "../model/snapshot";
import { ColorSwatches, ManualCopy, useCopy } from "./brand-kit-contents";
import styles from "./brand-assets.module.css";

type Props = {
  snapshot: BrandAssetSnapshot;
  pack: PreparedBrandAssets | null;
  previews: ReadonlyMap<string, string> | undefined;
  downloadFile(file?: BrandAssetFile): void;
  /** A download is being checked and started. */
  disabled: boolean;
  projectId: string;
  context: ContextSnapshot | null;
  directionTitle?: string;
  /** Progress of preparing or downloading the kit, announced politely. */
  status: string;
  /** The brand images are still being drawn. */
  preparing?: boolean;
  /** Draws the kit again, for images that could not be prepared. */
  onRetry?(): void;
  /** A message about the whole kit, shown under the download button. */
  notice?: ReactNode;
};
type Tab = "images" | "guidelines" | "system";
const TABS: readonly [Tab, string][] = [
  ["images", "Brand images"],
  ["guidelines", "Brand guidelines"],
  ["system", "Design system"],
];
const COUNT = ["No", "One", "Two", "Three", "Four", "Five", "Six"];
const SOCIAL_RATIO: Record<string, MediaRatio> = {
  profile: "1x1",
  "post-square": "1x1",
  "post-portrait": "4x5",
  "banner-wide": "3x1",
  "banner-cover": "4x1",
};

function saveText(name: string, type: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The chosen fonts are bundled with the app, so previews use the real type. */
function FontFaces({ snapshot }: { snapshot: BrandAssetSnapshot }) {
  const faces = [snapshot.heading, snapshot.body]
    .map((style) => brandBoardFont(style.family))
    .filter((font, index, all) => font && all.findIndex((other) => other?.id === font.id) === index);
  return (
    <style>
      {faces
        .map(
          (font) =>
            `@font-face{font-family:"${font!.family}";src:url("${font!.file}");font-weight:${font!.minWeight} ${font!.maxWeight};font-display:swap;}`,
        )
        .join("")}
    </style>
  );
}

/** The guidelines file itself, so the page and the download are one document.
 * Scripts never run inside it; links open in a new tab. */
function GuideDocument({ file, title, active }: { file: BrandAssetFile; title: string; active: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const html = useMemo(() => new TextDecoder().decode(file.bytes), [file]);
  const fit = useCallback(() => {
    const document = frame.current?.contentDocument?.documentElement;
    if (frame.current && document?.scrollHeight) frame.current.style.height = `${document.scrollHeight}px`;
  }, []);
  useEffect(() => {
    if (!active) return;
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [active, fit]);
  return (
    <iframe
      ref={frame}
      className={styles.guide}
      title={title}
      srcDoc={html}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      onLoad={fit}
    />
  );
}

/** Assets: one delivery page with the whole kit behind one button and three tabs
 * (Brand images, Brand guidelines, Design system), each file downloadable on its
 * own. Everything shown is built from the saved brand and the chosen direction. */
export function AssetsJourney({
  snapshot,
  pack,
  previews,
  downloadFile,
  disabled,
  projectId,
  context,
  directionTitle,
  status,
  preparing = !pack,
  onRetry,
  notice = null,
}: Props) {
  const id = useId();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("images");
  const tabs = useRef(new Map<Tab, HTMLButtonElement | null>());
  const [format, setFormat] = useState<"css" | "json">("css");
  const { copy, failed: copyFailed } = useCopy();
  const files = pack?.files ?? [];
  const failed = pack?.failed ?? [];
  const tokens = useMemo(() => designTokens(snapshot), [snapshot]);
  const slogan = context ? guidedSlogan(context) : null;
  const positioning = context?.positioning || null;
  const p = snapshot.palette;
  const base = `/brands/account/${projectId}`;
  const board = files.find((file) => file.category === "board");
  const boardPreview = board ? previews?.get(board.name) : undefined;
  const guide = files.find((file) => file.category === "guide" && file.mimeType === "text/html");
  const fileNamed = (name: string) => files.find((file) => file.name === name);
  const failedNamed = (name: string) => failed.some((item) => item.name === name);
  const heading = {
    fontFamily: `"${snapshot.heading.family}", system-ui, sans-serif`,
    fontWeight: snapshot.heading.weight,
  };
  const body: CSSProperties = {
    fontFamily: `"${snapshot.body.family}", system-ui, sans-serif`,
    fontWeight: snapshot.body.weight,
  };
  const exportText = format === "css" ? designTokensCss(tokens) : designTokensJson(tokens);
  // The accent carries text only where it is readable; otherwise it is a fill.
  const accentReadable = contrast(p.accent, p.background) >= 4.5;
  const imageCount = BRAND_APPLICATIONS.length + 1;
  const hint = preparing
    ? "The brand kit can be downloaded when your brand images are ready."
    : `Logo files, ${failed.length ? `${imageCount - failed.length} of ${imageCount} images` : "images"}, guidelines and tokens · ZIP · ${files.length} files`;

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = TABS.findIndex(([key]) => key === tab);
    const to =
      event.key === "ArrowRight"
        ? (at + 1) % TABS.length
        : event.key === "ArrowLeft"
          ? (at - 1 + TABS.length) % TABS.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? TABS.length - 1
              : null;
    if (to === null) return;
    event.preventDefault();
    const next = TABS[to]![0];
    setTab(next);
    tabs.current.get(next)?.focus();
  };
  const panel = (key: Tab) => ({
    id: `${id}-${key}-panel`,
    role: "tabpanel",
    "aria-labelledby": `${id}-${key}-tab`,
    hidden: tab !== key,
    className: styles.panel,
  });

  const download = (file: BrandAssetFile | undefined, label: string, kind: string) => (
    <Button
      size="sm"
      icon="download"
      aria-label={`Download ${label} as ${kind}`}
      disabled={!file || disabled}
      onClick={() => file && downloadFile(file)}
    >
      Download {kind}
    </Button>
  );
  const downloadMenu = (png: BrandAssetFile | undefined, svg: BrandAssetFile | undefined, label: string) =>
    png ? (
      <Menu
        items={[
          { kind: "action", label: "PNG image", icon: "image", onSelect: () => downloadFile(png) },
          ...(svg
            ? [
                {
                  kind: "action" as const,
                  label: "SVG you can edit",
                  icon: "pencil" as const,
                  onSelect: () => downloadFile(svg),
                },
              ]
            : []),
        ]}
        trigger={(props) => (
          <Button {...props} size="sm" icon="download" aria-label={`Download ${label}`} disabled={disabled}>
            Download
            <Icon name="chevron-down" size="sm" />
          </Button>
        )}
      />
    ) : (
      <Button size="sm" icon="download" aria-label={`Download ${label}`} disabled>
        Download
        <Icon name="chevron-down" size="sm" />
      </Button>
    );
  const picture = (name: string, ratio: MediaRatio, alt: string, flush = false) => {
    const preview = previews?.get(`${name}.png`);
    const className = flush ? styles.flush : undefined;
    if (preview) return <MediaFrame ratio={ratio} src={preview} alt={alt} className={className} />;
    if (failedNamed(name) || (pack && !preview))
      return (
        <MediaFrame ratio={ratio} state="failed" failedText="This image couldn’t be prepared." className={className} />
      );
    return <MediaFrame ratio={ratio} state="loading" className={className} />;
  };
  const socialCards = BRAND_APPLICATIONS.filter((spec) => spec.width / spec.height < 2);
  const banners = BRAND_APPLICATIONS.filter((spec) => spec.width / spec.height >= 2);
  const meta = (spec: (typeof BRAND_APPLICATIONS)[number]) =>
    `${spec.width} × ${spec.height} · ${spec.editable ? "PNG and SVG" : "PNG"}`;
  const failedNames = failed.map((item) => `the ${item.label.toLowerCase()}`);
  const failedList =
    failedNames.length > 1 ? `${failedNames.slice(0, -1).join(", ")} and ${failedNames.at(-1)}` : failedNames[0];

  return (
    <div className={styles.page}>
      <FontFaces snapshot={snapshot} />
      <header className="e-stack e-stack--xs">
        <h1 className={styles.title} translate="no">
          {snapshot.name}
        </h1>
        <p className={styles.lead}>
          Your brand kit, made from your logo and your direction{directionTitle ? `, ${directionTitle}` : ""}.
        </p>
      </header>

      <div className="e-stack e-stack--sm">
        <div className="e-section-bar">
          <div className="e-tabs" role="tablist" aria-label="Your brand kit" onKeyDown={onTabKey}>
            {TABS.map(([key, label]) => (
              <button
                key={key}
                ref={(node) => {
                  tabs.current.set(key, node);
                }}
                type="button"
                className="e-tab"
                role="tab"
                id={`${id}-${key}-tab`}
                aria-controls={`${id}-${key}-panel`}
                aria-selected={tab === key}
                tabIndex={tab === key ? 0 : -1}
                onClick={() => setTab(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={buttonClass({ variant: "primary" })}
            aria-describedby={`${id}-kit`}
            aria-busy={preparing || disabled || undefined}
            disabled={disabled}
            onClick={() => downloadFile()}
          >
            {preparing ? <Spinner /> : <Icon name="download" size="sm" />}
            {preparing ? "Preparing brand kit" : "Download brand kit"}
          </button>
        </div>
        <p className="e-section__hint e-tabular" id={`${id}-kit`}>
          {hint}
        </p>
        <p className="e-sr" role="status">
          {status}
        </p>
      </div>

      {notice}
      {preparing && (
        <div className="e-card e-card--pad">
          <div className="e-progress" data-state="running">
            <div className="e-progress__row">
              <p className="e-progress__status">
                Preparing your brand images and guidelines. This usually takes under a minute. Your design system is
                ready now.
              </p>
            </div>
            <div className="e-progress__track" />
          </div>
        </div>
      )}
      {failed.length > 0 && (
        <InlineMessage
          tone="danger"
          actions={
            onRetry && (
              <Button size="sm" icon="rotate-ccw" onClick={onRetry} disabled={disabled}>
                Retry {failed.length} {failed.length === 1 ? "image" : "images"}
              </Button>
            )
          }
        >
          {COUNT[failed.length] ?? failed.length} brand {failed.length === 1 ? "image" : "images"} couldn’t be prepared:{" "}
          {failedList}. Everything else is ready.
        </InlineMessage>
      )}

      <div {...panel("images")}>
        <section className="e-compare" aria-labelledby={`${id}-board`}>
          <div className={`e-card ${styles.cardClip}`}>
            {boardPreview ? (
              <MediaFrame
                ratio="8x11"
                src={boardPreview}
                alt={`${snapshot.name} final brand board`}
                className={styles.flush}
              />
            ) : (
              picture("brand-board", "8x11", "", true)
            )}
          </div>
          <div className="e-compare__side">
            <div className="e-stack e-stack--sm">
              <h2 className="e-section__title" id={`${id}-board`}>
                Brand board
              </h2>
              <p>Your logo, colors and type on one page, with details from your direction.</p>
              <p className="e-section__hint e-tabular">1600 × 2200 · PNG</p>
            </div>
            <div>{download(board, "brand board", "PNG")}</div>
          </div>
        </section>

        <section className="e-section" aria-labelledby={`${id}-social`}>
          <div className="e-section__head">
            <h2 className="e-section__title" id={`${id}-social`}>
              Social images
            </h2>
            <p className="e-section__hint">
              Ready to upload as PNG. Posts and banners also come as SVG files you can edit.
            </p>
          </div>
          <ul className={`e-grid-cards ${styles.list}`} aria-label="Profile image and post templates">
            {socialCards.map((spec) => {
              const png = fileNamed(`social/${spec.id}.png`),
                svg = fileNamed(`social/${spec.id}.svg`),
                label = spec.label.toLowerCase();
              return (
                <li key={spec.id} className={`e-card ${styles.socialCard}`}>
                  <div className={styles.stage}>
                    {picture(`social/${spec.id}`, SOCIAL_RATIO[spec.id]!, `${snapshot.name} ${label}`)}
                  </div>
                  <div className={`e-card__body ${styles.cardBody}`}>
                    <div className="e-stack e-stack--xs">
                      <h3 className="e-card__title">{spec.label}</h3>
                      <span className="e-card__meta e-tabular">{meta(spec)}</span>
                    </div>
                    <div>{spec.editable ? downloadMenu(png, svg, label) : download(png, label, "PNG")}</div>
                  </div>
                </li>
              );
            })}
          </ul>
          <ul className={`e-stack ${styles.list}`} aria-label="Banners">
            {banners.map((spec) => {
              const png = fileNamed(`social/${spec.id}.png`),
                svg = fileNamed(`social/${spec.id}.svg`),
                label = spec.label.toLowerCase();
              return (
                <li key={spec.id} className={`e-card ${styles.cardClip}`}>
                  {picture(`social/${spec.id}`, SOCIAL_RATIO[spec.id]!, `${snapshot.name} ${label}`, true)}
                  <div className="e-card__body">
                    <div className="e-cluster e-cluster--between">
                      <div className="e-stack e-stack--xs">
                        <h3 className="e-card__title">{spec.label}</h3>
                        <span className="e-card__meta e-tabular">{meta(spec)}</span>
                      </div>
                      {downloadMenu(png, svg, label)}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      </div>

      <div {...panel("guidelines")}>
        <section className="e-section" aria-labelledby={`${id}-guide`}>
          <div className="e-cluster e-cluster--between e-cluster--top">
            <div className="e-section__head">
              <h2 className="e-section__title" id={`${id}-guide`}>
                Brand guidelines
              </h2>
              <p className="e-section__hint">
                Everything someone needs to use <span translate="no">{snapshot.name}</span> consistently. The file you
                download is this document.
              </p>
            </div>
            <Button
              icon="download"
              className="e-button--block-compact"
              disabled={!guide || disabled}
              onClick={() => guide && downloadFile(guide)}
            >
              Download guidelines
            </Button>
          </div>
          <p className="e-section__hint">
            To change something, go back to the step it comes from:{" "}
            <Link className="e-link" href={`${base}/logo`}>
              Logo
            </Link>
            ,{" "}
            <Link className="e-link" href={`${base}/logo/directions`}>
              Creative direction
            </Link>{" "}
            or{" "}
            <Link className="e-link" href={`${base}?view=strategy#journey-voice`}>
              Voice
            </Link>
            .
          </p>
          <div className={`e-card ${styles.cardClip}`}>
            {guide ? (
              <GuideDocument file={guide} title={`${snapshot.name} brand guidelines`} active={tab === "guidelines"} />
            ) : (
              <MediaFrame ratio="8x11" state="loading" className={styles.flush} />
            )}
          </div>
        </section>
      </div>

      <div {...panel("system")}>
        <section className="e-section" aria-labelledby={`${id}-system`}>
          <div className="e-section__head">
            <h2 className="e-section__title" id={`${id}-system`}>
              Design system
            </h2>
            <p className="e-section__hint">
              So your website, shop or app looks like <span translate="no">{snapshot.name}</span> from day one. Copy the
              values you need, or download them for your tools.
            </p>
          </div>
          <div className={`e-card ${styles.cardClip}`}>
            <div
              className={styles.preview}
              role="img"
              aria-label={`Preview: a heading, a sentence and two buttons in the ${snapshot.name} colors and type`}
              style={{ background: p.background, color: p.text, ...body }}
            >
              <p style={{ ...heading, fontSize: 32, lineHeight: 1.15 }}>{slogan ?? snapshot.name}</p>
              {positioning && <p>{positioning}</p>}
              <span className={styles.previewActions}>
                <span
                  style={{
                    background: p.primary,
                    color: readableBrandColor(snapshot, p.primary, [p.background]),
                  }}
                >
                  Get started
                </span>
                <span
                  style={{ borderColor: p.primary, color: readableBrandColor(snapshot, p.background, [p.primary]) }}
                >
                  Learn more
                </span>
                <span
                  className={styles.pill}
                  data-accent={accentReadable ? "text" : "fill"}
                  style={
                    accentReadable
                      ? { color: p.accent, borderColor: p.accent }
                      : { background: p.accent, color: readableBrandColor(snapshot, p.accent, [p.primary]) }
                  }
                  translate="no"
                >
                  {snapshot.name}
                </span>
              </span>
            </div>
          </div>
        </section>

        <section className="e-section" aria-labelledby={`${id}-colors`}>
          <h2 className="e-section__title" id={`${id}-colors`}>
            Colors
          </h2>
          <ColorSwatches colors={tokens.colors} />
        </section>

        <section className="e-section" aria-labelledby={`${id}-type`}>
          <h2 className="e-section__title" id={`${id}-type`}>
            Type scale
          </h2>
          <div className="e-card e-card--pad" style={{ background: p.background, color: p.text }}>
            <div className={styles.typeScale} translate="no">
              {TYPE_SCALE.map((step) => {
                const style = step.role === "heading" ? snapshot.heading : snapshot.body;
                return (
                  <div key={step.key}>
                    <span className={styles.typeLabel}>
                      {step.label} · {step.size} / {style.family} {style.weight}
                    </span>
                    <span
                      style={{
                        ...(step.role === "heading" ? heading : body),
                        fontSize: step.size,
                        lineHeight: step.lineHeight,
                      }}
                    >
                      {step.role === "heading"
                        ? step.key === "display"
                          ? snapshot.name
                          : (slogan ?? snapshot.name)
                        : positioning || snapshot.name}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <section className="e-section" aria-labelledby={`${id}-export`}>
          <div className={styles.exportHead}>
            <h2 className="e-section__title" id={`${id}-export`}>
              Export
            </h2>
            <div className="e-segmented" role="group" aria-label="Format">
              {(["css", "json"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  className="e-segmented__item"
                  aria-pressed={format === value}
                  onClick={() => setFormat(value)}
                >
                  {value.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <div className="e-code">
            <pre tabIndex={0} translate="no">
              {exportText}
            </pre>
            <button
              type="button"
              className="e-icon-button e-icon-button--quiet e-icon-button--sm"
              aria-label={`Copy the ${format.toUpperCase()}`}
              onClick={() =>
                void copy(
                  `tokens-${format}`,
                  `Design tokens as ${format.toUpperCase()}`,
                  exportText,
                  `Copied the ${format.toUpperCase()}`,
                )
              }
            >
              <Icon name="copy" size="sm" />
            </button>
          </div>
          <ManualCopy failed={copyFailed} />
          <div className="e-form-actions">
            <Button
              icon="download"
              onClick={() => {
                saveText(
                  format === "css" ? "design-tokens.css" : "design-tokens.json",
                  format === "css" ? "text/css" : "application/json",
                  exportText,
                );
                toast("Design tokens downloaded");
              }}
            >
              Download {format.toUpperCase()}
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}
