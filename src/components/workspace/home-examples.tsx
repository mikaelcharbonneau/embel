import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { PLAN_MONTHLY_CREDITS } from "@/domain/billing";

/** Three brands Embel really made (the showcase brands, owner-approved November 11 and 14). The pictures are the
 * top-left 720 × 540 of each chosen direction board (design-assets/manifest.md, IMG-007). */
const examples = [
  {
    file: "kestrel",
    name: "Kestrel Analytics",
    alt: "Brand board for Kestrel Analytics, a B2B analytics platform: logo, colours and type made with Embel.",
  },
  {
    file: "orchard-lane",
    name: "Orchard Lane Cider",
    alt: "Brand board for Orchard Lane Cider, a craft cider maker: logo, colours and type made with Embel.",
  },
  {
    file: "tidewild",
    name: "Tidewild Hot Sauce",
    alt: "Brand board for Tidewild Hot Sauce, a small-batch fermented hot sauce: logo, colours and type made with Embel.",
  },
] as const;

/** The row of finished brands: proof of what Embel makes (D-017), and what a new account will get (D-060). */
export function HomeExamples({ title, text }: { title: string; text: string }) {
  return (
    <section className="home-section" aria-labelledby="home-examples-title">
      <div className="home-section__head">
        <div className="e-stack e-stack--xs">
          <h2 className="home-section__title" id="home-examples-title">
            {title}
          </h2>
          <p className="e-muted text-small">{text}</p>
        </div>
      </div>
      <ul className="home-example-grid">
        {examples.map((example, index) => (
          <li key={example.file}>
            <figure className="e-stack e-stack--md">
              <div className="e-media e-media--4x3">
                <picture>
                  <source
                    type="image/avif"
                    srcSet={`/home-examples/${example.file}-360.avif 360w, /home-examples/${example.file}-720.avif 720w`}
                    sizes="(min-width: 1024px) 336px, (min-width: 640px) 33vw, 100vw"
                  />
                  {/* eslint-disable-next-line @next/next/no-img-element -- pre-sized AVIF/WebP pairs, served as they are */}
                  <img
                    src={`/home-examples/${example.file}-720.webp`}
                    srcSet={`/home-examples/${example.file}-360.webp 360w, /home-examples/${example.file}-720.webp 720w`}
                    sizes="(min-width: 1024px) 336px, (min-width: 640px) 33vw, 100vw"
                    width={720}
                    height={540}
                    alt={example.alt}
                    fetchPriority={index === 0 ? "high" : undefined}
                    decoding="async"
                  />
                </picture>
              </div>
              <figcaption className="text-small" translate="no">
                {example.name}
              </figcaption>
            </figure>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One line under the ideas: what starting costs, in credits. */
export function HomeCreditsLine({ credits }: { credits: number | "signed_out" }) {
  return (
    <p className="home-credits">
      {credits === "signed_out" ? (
        <>
          <span>Free to start with {PLAN_MONTHLY_CREDITS.free} credits.</span>
          <Link className="e-link e-link--standalone" href="/plans">
            See plans
            <Icon name="arrow-right" size="sm" />
          </Link>
        </>
      ) : (
        <span>You have {credits.toLocaleString("en-US")} credits to start.</span>
      )}
    </p>
  );
}
