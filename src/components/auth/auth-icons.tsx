// Account and sign-in icons drawn like the shared Icon set (24px grid, 1.55 stroke).
function Glyph({ size, children }: { size: number; children: React.ReactNode }) {
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
    >
      {children}
    </svg>
  );
}

export function SignOutIcon({ size = 18 }: { size?: number }) {
  return (
    <Glyph size={size}>
      <path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" />
      <path d="M10 16l-4-4 4-4M6 12h10" />
    </Glyph>
  );
}

export function ShowPasswordIcon({ size = 18 }: { size?: number }) {
  return (
    <Glyph size={size}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </Glyph>
  );
}

export function HidePasswordIcon({ size = 18 }: { size?: number }) {
  return (
    <Glyph size={size}>
      <path d="M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.4 3.2M6.5 7.2C3.9 8.9 2.5 12 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.2-1" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18" />
    </Glyph>
  );
}
