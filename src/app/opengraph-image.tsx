import { ImageResponse } from "next/og";
import { brandColors, brandMarkDataUri, geistFont, siteDescription, siteTitle } from "./_brand/brand";

export const alt = siteTitle;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// The shared-link preview: the Embel mark and wordmark on the page canvas.
export default async function OpenGraphImage() {
  const [mark, medium, regular] = await Promise.all([brandMarkDataUri(), geistFont("Medium"), geistFont("Regular")]);
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 36,
        background: brandColors.canvas,
        color: brandColors.ink,
        fontFamily: "Geist",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 32 }}>
        <img src={mark} width={120} height={120} alt="" />
        <div style={{ fontSize: 136, fontWeight: 500, letterSpacing: -5, lineHeight: 1 }}>Embel</div>
      </div>
      <div
        style={{
          maxWidth: 860,
          fontSize: 36,
          fontWeight: 400,
          lineHeight: 1.35,
          color: brandColors.secondary,
          textAlign: "center",
        }}
      >
        {siteDescription}
      </div>
    </div>,
    {
      ...size,
      fonts: [
        { name: "Geist", data: medium, weight: 500, style: "normal" },
        { name: "Geist", data: regular, weight: 400, style: "normal" },
      ],
    },
  );
}
