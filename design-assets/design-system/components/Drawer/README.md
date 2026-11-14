# Drawer and sheet

A panel that slides from an edge. You provide the title, the content and the actions.

- **Right-edge drawer**: a detail view next to a list (an asset in Library). Widths 480 px and 860 px.
- **Bottom sheet**: the compact form of every dialog and drawer.
- Slides with `ease-drawer` over `duration-slow`; closes instantly. Under reduced motion it fades.
- Same parts, scrim, shadow and focus rules as Dialog. A sticky header reserves scroll padding so focus is never hidden under it.
