import Image from "next/image";

/**
 * The tilted wall of brand images beside the form in the sign-in overlay. Decoration only: it is hidden from
 * assistive technology and from narrow screens. The pictures are the reference brands of the Inspiration step
 * (public/inspiration/brands), so the label says what they are; none were made by Embel's customers.
 */
const columns: readonly (readonly string[])[] = [
  ["forma", "avelo", "glowe", "kordex", "origo", "velto"],
  ["archi-tex", "flyra", "nutrico", "karmapay", "wellis", "zapp"],
  ["aurox", "handi", "maroc", "pavea", "synexa", "travil"],
  ["asteor", "curvex", "eduflow", "helixa", "lyvio", "verso"],
  ["auraic", "cadora", "fluxev", "homis", "nexara", "vetter"],
  ["autonex", "buildit", "drivecare", "humo", "raygle", "veratix"],
  ["avoova", "axian", "dustbit", "kelvion", "korevia", "servexo"],
];

export const authWallBrands: readonly string[] = columns.flat();

export function AuthWall() {
  return (
    <div className="auth-wall" aria-hidden="true">
      <div className="auth-wall__grid">
        {columns.map((column, index) => (
          <div className="auth-wall__column" key={index}>
            {column.map((slug) => (
              <Image
                key={slug}
                className="auth-wall__image"
                src={`/inspiration/brands/${slug}/05-brand-poster-small.webp`}
                width={180}
                height={225}
                sizes="180px"
                alt=""
              />
            ))}
          </div>
        ))}
      </div>
      <p className="auth-wall__label">Brand inspiration</p>
    </div>
  );
}
