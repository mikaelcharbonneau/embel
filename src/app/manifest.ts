import type { MetadataRoute } from "next";
import { brandColors } from "./_brand/brand";

// Name and icons for "Add to Home Screen" and installed tabs: the Embel mark on the page canvas.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Embel",
    short_name: "Embel",
    description: "Turn a product idea into a usable brand: name, logo, colors and files.",
    start_url: "/",
    display: "browser",
    background_color: brandColors.canvas,
    theme_color: brandColors.canvas,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
