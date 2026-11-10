import type { LogoVectorDocument } from "../../../src/domain/logo-vector";

/** Synthetic original geometry for local tests only; no provider output or saved history. */
export function separatedLogoDocument(): LogoVectorDocument {
  return {
    version: 1,
    viewBox: [0, 0, 200, 120],
    components: [
      {
        id: "synthetic-symbol",
        role: "symbol",
        editingKind: "geometry",
        transform: { x: 0, y: 0, scale: 1, rotation: 0 },
        paths: [
          {
            id: "synthetic-diamond",
            d: "M 20 40 L 40 20 L 60 40 L 40 60 Z",
            fill: { color: "#DB2777", opacity: 1 },
            stroke: null,
            fillRule: "nonzero",
          },
        ],
      },
      {
        id: "synthetic-lettering",
        role: "lettering",
        editingKind: "outlined_custom",
        transform: { x: 0, y: 0, scale: 1, rotation: 0 },
        paths: [
          {
            id: "synthetic-bars",
            d: "M 85 30 L 145 30 L 145 40 L 85 40 Z M 85 50 L 130 50 L 130 60 L 85 60 Z",
            fill: { color: "#111827", opacity: 1 },
            stroke: null,
            fillRule: "evenodd",
          },
        ],
      },
    ],
  };
}
