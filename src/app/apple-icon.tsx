import { ImageResponse } from "next/og";
import { brandColors, brandMarkDataUri } from "./_brand/brand";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// The Embel mark on the page canvas, for home screens and bookmarks.
export default async function AppleIcon() {
  const mark = await brandMarkDataUri();
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: brandColors.canvas,
      }}
    >
      <img src={mark} width={112} height={112} alt="" />
    </div>,
    size,
  );
}
