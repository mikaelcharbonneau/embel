"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Spinner } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { InlineMessage } from "@/components/ui/message";
import { useAccountSession, type VerifiedAccount } from "@/components/workspace/account-session";
import { evidenceSchema, platforms, type HandleEvidence } from "@/features/handles-workspace/domain";
import { handleProfileUrl } from "@/features/handles-workspace/manual-tools";
import { previewHandleSearch } from "@/features/handles-workspace/search";
import { checkedTime, type LiveChecks } from "./use-live-checks";
import styles from "./name-details.module.css";

type Separator = "" | "_" | ".";
const separators: { value: Separator; label: string }[] = [
  { value: "", label: "None" },
  { value: "_", label: "Underscore _" },
  { value: ".", label: "Dot ." },
];

/**
 * Handle ideas for a name across five platforms. Only YouTube is checked by Embel, and only when that check is
 * connected and the person presses Check; every other platform opens the profile page so the person can see for
 * themselves whether it exists.
 */
export function HandlesPanel({
  name,
  account,
  handles,
}: {
  name: string;
  account: VerifiedAccount;
  handles: LiveChecks["handles"] | null;
}) {
  const { isCurrent } = useAccountSession();
  const [handle, setHandle] = useState(() => name.trim().replace(/\s+/gu, "").toLowerCase());
  const [prefixes, setPrefixes] = useState("");
  const [suffixes, setSuffixes] = useState("");
  const [separator, setSeparator] = useState<Separator>("_");
  const [evidence, setEvidence] = useState<Map<string, HandleEvidence>>(new Map());
  const [checking, setChecking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useRef<AbortController | null>(null);
  useEffect(() => () => run.current?.abort(), []);
  const preview = useMemo(() => {
    try {
      const source = { id: "name", name: handle || " ", origin: "names" as const, projectId: null, projectTitle: null };
      const found = previewHandleSearch(
        [source],
        platforms.map((platform) => platform.id),
        { prefixes, suffixes, separators: [separator] },
      );
      return {
        rows: found.rows.map((row) => ({
          handle: row.entries[0]!.handle,
          platforms: new Set(row.entries.map((entry) => entry.platform)),
        })),
        problem: null,
      };
    } catch (cause) {
      return { rows: [], problem: cause instanceof Error ? cause.message : "These handles can’t be listed." };
    }
  }, [handle, prefixes, suffixes, separator]);
  const youtube = handles?.availability === "ready";
  const youtubeRows = preview.rows.filter((row) => row.platforms.has("youtube")).map((row) => row.handle);
  const checkedAt = [...evidence.values()]
    .map((item) => item.checkedAt ?? item.observedAt)
    .sort()
    .at(-1);

  async function check() {
    if (!handles || !youtube || run.current || !youtubeRows.length || !isCurrent(account)) return;
    const controller = new AbortController();
    run.current = controller;
    setError(null);
    const live = () => !controller.signal.aborted && run.current === controller && isCurrent(account);
    try {
      for (const value of youtubeRows) {
        if (!live()) return;
        setChecking(value);
        try {
          const found = evidenceSchema.parse(
            await handles.check({ platform: "youtube", handle: value }, controller.signal),
          );
          if (!live()) return;
          setEvidence((old) => new Map(old).set(value, found));
        } catch (cause) {
          if (!live()) return;
          setError(cause instanceof Error ? cause.message : "YouTube could not be checked.");
          return;
        }
      }
    } finally {
      if (run.current === controller) {
        run.current = null;
        setChecking(null);
      }
    }
  }
  const edit = (change: () => void) => {
    run.current?.abort();
    run.current = null;
    setChecking(null);
    change();
  };
  return (
    <div className="e-stack">
      <div className={styles.handleFields}>
        <TextField
          label="Handle"
          value={handle}
          maxLength={64}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => edit(() => setHandle(event.target.value))}
        />
        <TextField
          label="Prefixes"
          optional
          placeholder="get"
          value={prefixes}
          maxLength={120}
          onChange={(event) => edit(() => setPrefixes(event.target.value))}
        />
        <TextField
          label="Suffixes"
          optional
          placeholder="hq"
          value={suffixes}
          maxLength={120}
          onChange={(event) => edit(() => setSuffixes(event.target.value))}
        />
      </div>
      <div className={styles.toolbar}>
        <div className="e-stack e-stack--sm">
          <span className="e-field__label" id="name-handles-separator">
            Separator
          </span>
          <div className="e-segmented" role="group" aria-labelledby="name-handles-separator">
            {separators.map((option) => (
              <button
                key={option.label}
                type="button"
                className="e-segmented__item"
                aria-pressed={separator === option.value}
                onClick={() => edit(() => setSeparator(option.value))}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        {youtube && (
          <Button
            variant="primary"
            icon="search"
            loading={Boolean(checking)}
            disabled={!youtubeRows.length}
            onClick={() => void check()}
          >
            Check {youtubeRows.length} {youtubeRows.length === 1 ? "handle" : "handles"} on YouTube
          </Button>
        )}
      </div>
      {preview.problem && <InlineMessage tone="warning">{preview.problem}</InlineMessage>}
      {preview.rows.length > 0 && (
        <table className="e-table">
          <caption className="e-sr">Handles for {name}</caption>
          <thead>
            <tr>
              <th scope="col">Handle</th>
              {platforms.map((platform) => (
                <th key={platform.id} scope="col">
                  {platform.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row) => (
              <tr key={row.handle}>
                <td className={styles.domain}>@{row.handle}</td>
                {platforms.map((platform) => {
                  if (!row.platforms.has(platform.id))
                    return (
                      <td key={platform.id} className="e-muted">
                        <span aria-hidden="true">—</span>
                        <span className="e-sr">Not allowed on {platform.label}</span>
                      </td>
                    );
                  if (platform.id === "youtube" && youtube) {
                    const found = evidence.get(row.handle);
                    if (checking === row.handle)
                      return (
                        <td key={platform.id}>
                          <Spinner label={`Checking @${row.handle} on YouTube`} />
                        </td>
                      );
                    if (found)
                      return (
                        <td key={platform.id}>
                          <span
                            className={
                              found.outcome === "confirmed_available"
                                ? "e-badge e-badge--positive"
                                : found.outcome === "taken"
                                  ? "e-badge e-badge--danger"
                                  : "e-badge"
                            }
                            data-status={found.outcome}
                          >
                            {found.outcome === "confirmed_available"
                              ? "Available"
                              : found.outcome === "taken"
                                ? "Taken"
                                : "Not confirmed"}
                          </span>
                        </td>
                      );
                    return (
                      <td key={platform.id}>
                        <span className="e-badge">Not checked</span>
                      </td>
                    );
                  }
                  return (
                    <td key={platform.id}>
                      <a
                        className="e-link"
                        href={handleProfileUrl({ platform: platform.id, handle: row.handle })}
                        target="_blank"
                        rel="noopener noreferrer"
                        referrerPolicy="no-referrer"
                      >
                        Open
                        <span className="e-sr">
                          {" "}
                          @{row.handle} on {platform.label}
                        </span>
                      </a>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {error && <InlineMessage tone="danger">{error}</InlineMessage>}
      <p className={`e-muted ${styles.small}`}>
        {youtube
          ? `Embel checks YouTube for you${checkedAt ? ` (checked ${checkedTime(checkedAt)})` : " when you press Check"}. For the other platforms, Open shows whether the profile exists. Checking doesn’t reserve a handle.`
          : handles === null
            ? "Checking which lookups are connected…"
            : "Embel can’t check handles right now. Open shows each platform’s profile page, so you can see whether it exists. Opening doesn’t reserve a handle."}
      </p>
    </div>
  );
}
