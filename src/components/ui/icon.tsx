import type { CSSProperties } from "react";

type IconName =
  | "home"
  | "brands"
  | "assets"
  | "settings"
  | "team"
  | "plus"
  | "arrow"
  | "chevron"
  | "check"
  | "close"
  | "menu"
  | "file"
  | "device"
  | "clock"
  | "pencil"
  | "trash"
  | "layers"
  | "offline"
  | "user"
  | "refresh"
  | "mic"
  | "arrow-up"
  | "search"
  | "palette";

const paths: Record<IconName, React.ReactNode> = {
  palette: (
    <>
      <path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1.4-3.4 1.5 1.5 0 0 1 1.1-2.6H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8Z" />
      <circle cx="7.5" cy="10.5" r=".5" />
      <circle cx="10" cy="6.5" r=".5" />
      <circle cx="15" cy="6.5" r=".5" />
      <circle cx="17.5" cy="10.5" r=".5" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M5 21v-2a7 7 0 0 1 14 0v2" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 4v6h-6M4 20v-6h6" />
      <path d="M5.2 8a8 8 0 0 1 13.2-3L20 7M4 17l1.6 2A8 8 0 0 0 19 16" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="2" width="6" height="13" rx="3" />
      <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3" />
    </>
  ),
  "arrow-up": <path d="M12 20V4m-6 6 6-6 6 6" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="7.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  home: (
    <>
      <path d="m3 10 9-7 9 7" />
      <path d="M5 9v11h5v-6h4v6h5V9" />
    </>
  ),
  brands: (
    <>
      <path d="m3 7 9-5 9 5-9 5Zm0 7 9 5 9-5M3 14l3-2m15 2-3-2" />
    </>
  ),
  assets: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="m3 16 5-5 4 4 3-3 6 6" />
      <circle cx="16" cy="9" r="1" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h16M4 17h16" />
      <circle cx="9" cy="7" r="3" fill="currentColor" stroke="none" />
      <circle cx="15" cy="17" r="3" fill="currentColor" stroke="none" />
    </>
  ),
  team: (
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20v-2a6 6 0 0 1 12 0v2m2-15a3 3 0 0 1 0 6m1 3a5 5 0 0 1 3 4v2" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  arrow: <path d="M4 12h15m-6-6 6 6-6 6" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  check: <path d="m5 12 4 4L19 6" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  file: (
    <>
      <path d="M14 3H5v18h14V8Z" />
      <path d="M14 3v5h5M8 12h8m-8 4h5" />
    </>
  ),
  device: (
    <>
      <rect x="4" y="4" width="16" height="12" rx="2" />
      <path d="M2 20h20M9 16v4m6-4v4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  pencil: (
    <>
      <path d="m4 16-1 5 5-1L20 8l-4-4Z" />
      <path d="m13 7 4 4" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />
    </>
  ),
  layers: (
    <>
      <path d="m3 7 9-4 9 4-9 4Zm0 5 9 4 9-4M3 17l9 4 9-4" />
    </>
  ),
  offline: (
    <>
      <path d="m3 3 18 18M8 4.8A10 10 0 0 1 22 12m-20 0a10 10 0 0 1 2.7-6.8M8 12a4 4 0 0 0 4 4m2.8-6.8A4 4 0 0 0 12 8" />
      <circle cx="12" cy="21" r=".75" fill="currentColor" />
    </>
  ),
};

export function Icon({
  name,
  size = 20,
  className,
  style,
}: {
  name: IconName;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.55"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
    >
      {paths[name]}
    </svg>
  );
}
