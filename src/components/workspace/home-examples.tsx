import Link from "next/link";
import { Icon } from "@/components/ui/icon";

/** Three brands Embel really made (the showcase brands, owner-approved November 11 and 14). The pictures are the
 * top-left 720 × 540 of each chosen direction board (design-assets/manifest.md, IMG-007). */
const examples = [
  {
    file: "kestrel",
    name: "Kestrel Analytics",
    alt: "Brand board for Kestrel Analytics, a B2B analytics platform: logo, colors and type made with Embel.",
  },
  {
    file: "orchard-lane",
    name: "Orchard Lane Cider",
    alt: "Brand board for Orchard Lane Cider, a craft cider maker: logo, colors and type made with Embel.",
  },
  {
    file: "tidewild",
    name: "Tidewild Hot Sauce",
    alt: "Brand board for Tidewild Hot Sauce, a small-batch fermented hot sauce: logo, colors and type made with Embel.",
  },
] as const;

/** The row of finished brands: proof of what Embel makes (D-017), and what a new account will get (D-060). */
export function HomeExamples() {
  return (
    <section className="home-section" aria-labelledby="home-examples-title">
      <h2 className="home-section__title" id="home-examples-title">
        Made with Embel
      </h2>
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

/** One line under the ideas: the way to Plans when signed out, or a new account's credits. */
export function HomeCreditsLine({ credits }: { credits: number | "signed_out" }) {
  return (
    <p className="home-credits">
      {credits === "signed_out" ? (
        <Link className="e-link e-link--standalone" href="/plans">
          See plans
          <Icon name="arrow-right" size="sm" />
        </Link>
      ) : (
        <span>You have {credits.toLocaleString("en-US")} credits to start.</span>
      )}
    </p>
  );
}
