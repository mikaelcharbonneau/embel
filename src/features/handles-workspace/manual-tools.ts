import { entrySchema, handleStatus, lastCheckedAt, platforms, statusLabels, type HandleEntry } from "./domain";

/** Profile links support manual inspection, never an availability observation. */
export function handleProfileUrl(entry: Pick<HandleEntry, "platform" | "handle">): string {
  const platform = entrySchema.shape.platform.parse(entry.platform);
  const handle = encodeURIComponent(entrySchema.shape.handle.parse(entry.handle));
  switch (platform) {
    case "instagram":
      return `https://www.instagram.com/${handle}/`;
    case "tiktok":
      return `https://www.tiktok.com/@${handle}`;
    case "youtube":
      return `https://www.youtube.com/@${handle}`;
    case "x":
      return `https://x.com/${handle}`;
    case "linkedin":
      return `https://www.linkedin.com/company/${handle}/`;
  }
}

export function handlesCsv(rows: readonly { name: string; entries: readonly HandleEntry[] }[]): string {
  // CSV quoting alone does not stop spreadsheet formula interpretation.
  const cell = (value: string) =>
    `"${(/^[\s\u0000-\u001f]*[=+@-]/u.test(value) ? "'" + value : value).replace(/"/g, '""')}"`;
  const lines = [
    [
      "Name or bundle",
      "Platform",
      "Handle",
      "Recorded availability",
      "Last checked (UTC)",
      "Profile URL",
      "User-declared account URL",
    ],
    ...rows.flatMap((row) =>
      row.entries.map((raw) => {
        const entry = entrySchema.parse(raw);
        return [
          row.name,
          platforms.find((platform) => platform.id === entry.platform)!.label,
          entry.handle,
          handleStatus(entry) === "to_check" ? "Unknown" : statusLabels[handleStatus(entry)],
          lastCheckedAt(entry) ?? "",
          handleProfileUrl(entry),
          entry.accountCreated?.url ?? "",
        ];
      }),
    ),
  ];
  return lines.map((line) => line.map(cell).join(",")).join("\r\n") + "\r\n";
}
