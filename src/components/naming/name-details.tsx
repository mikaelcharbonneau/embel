"use client";

import { useId, useState, type KeyboardEvent } from "react";
import { Button, IconButton } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { InlineMessage } from "@/components/ui/message";
import type { VerifiedAccount } from "@/components/workspace/account-session";
import type { ProjectNameEntry } from "@/domain/project-naming";
import { DomainPanels, DomainsPanel, useDomainSearch } from "./name-domains";
import { HandlesPanel } from "./name-handles";
import { TrademarksPanel } from "./name-trademarks";
import { useLiveChecks } from "./use-live-checks";
import { WorkAreaLayer } from "@/components/workspace/work-area-layer";
import styles from "./name-details.module.css";

const tabs = ["Domains", "Handles", "Trademarks"] as const;
type Tab = (typeof tabs)[number];

/**
 * A name's details: its story and the checks Embel can run for it. An extra-large dialog over the work area
 * (in the Workspace overlay when there is one, otherwise an ordinary modal dialog). Choosing the name here marks it,
 * as on its card; Send in the reply box moves on.
 */
export function NameDetails({
  account,
  entry,
  chosen,
  earlierContext,
  pending,
  blocked,
  error,
  overlay,
  onClose,
  onRefresh,
  onChoose,
  onSave,
  onFavorite,
  onSteering,
  steeringSelected,
  steeringDisabled,
}: {
  account: VerifiedAccount;
  entry: ProjectNameEntry;
  chosen: boolean;
  earlierContext: boolean;
  pending: boolean;
  blocked: boolean;
  error?: string | null;
  overlay?: HTMLElement | null;
  onClose: () => void;
  onRefresh: () => void;
  onChoose: () => void;
  onSave: () => void;
  onFavorite: () => void;
  onSteering?: () => void;
  steeringSelected: boolean;
  steeringDisabled: boolean;
}) {
  const { candidate, retention } = entry;
  const name = candidate.value;
  const id = useId();
  const [tab, setTab] = useState<Tab>("Domains");
  const live = useLiveChecks(account);
  const domains = useDomainSearch(name, account, live.adapters?.domains ?? null);
  const badge =
    candidate.origin.kind === "local_import"
      ? "Your name"
      : earlierContext
        ? "Earlier strategy"
        : candidate.origin.kind === "brainstorm"
          ? "Unchecked brainstorm"
          : null;
  const keys = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!delta && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const next =
      tabs[
        event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + tabs.length + delta) % tabs.length
      ]!;
    setTab(next);
    document.getElementById(`${id}-${next}`)?.focus();
  };
  return (
    <>
      <WorkAreaLayer host={overlay} onEscape={onClose}>
        <Dialog
          size="xl"
          modal={!overlay}
          title={name}
          aside={badge ? <span className="e-badge">{badge}</span> : undefined}
          description={candidate.rationale || undefined}
          closeLabel="Close name details"
          className={styles.details}
          onClose={onClose}
          actions={
            <IconButton
              icon="heart"
              label={`${retention.favorite ? "Unfavorite" : "Favorite"} ${name}`}
              pressed={retention.favorite}
              tooltip={false}
              disabled={pending}
              onClick={onFavorite}
            />
          }
          footer={
            <>
              {onSteering && (
                <label className={`e-check ${styles.footerStart}`}>
                  <input
                    type="checkbox"
                    className="e-box"
                    checked={steeringSelected}
                    disabled={steeringDisabled}
                    onChange={onSteering}
                  />
                  <span>
                    More like this<span className="e-sr">: {name}</span>
                  </span>
                </label>
              )}
              <Button icon="heart" aria-pressed={retention.saved} disabled={pending} onClick={onSave}>
                {retention.saved ? "Saved name" : "Save name"}
              </Button>
              {chosen ? (
                <Button variant="quiet" aria-pressed disabled>
                  Chosen name
                </Button>
              ) : (
                <Button variant="primary" disabled={pending || blocked} onClick={onChoose}>
                  Choose this name
                </Button>
              )}
            </>
          }
        >
          <div className="e-tabs" role="tablist" aria-label="Checks for this name">
            {tabs.map((item, index) => (
              <button
                key={item}
                id={`${id}-${item}`}
                type="button"
                role="tab"
                className="e-tab"
                aria-selected={tab === item}
                aria-controls={`${id}-panel`}
                tabIndex={tab === item ? 0 : -1}
                onClick={() => setTab(item)}
                onKeyDown={(event) => keys(event, index)}
              >
                {item}
              </button>
            ))}
          </div>
          <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}`} className={styles.panel}>
            {live.connectionError ? (
              <InlineMessage
                tone="danger"
                actions={
                  <Button size="sm" onClick={live.retry}>
                    Try again
                  </Button>
                }
              >
                Embel couldn’t tell which checks are connected.
              </InlineMessage>
            ) : null}
            {tab === "Domains" ? (
              <DomainsPanel search={domains} adapter={live.adapters?.domains ?? null} />
            ) : tab === "Handles" ? (
              <HandlesPanel name={name} account={account} handles={live.adapters?.handles ?? null} />
            ) : (
              <TrademarksPanel name={name} account={account} trademarks={live.adapters?.trademarks ?? null} />
            )}
          </div>
          {error && (
            <InlineMessage
              tone="danger"
              actions={
                <Button size="sm" disabled={pending} onClick={onRefresh}>
                  Check latest version
                </Button>
              }
            >
              {error}
            </InlineMessage>
          )}
        </Dialog>
      </WorkAreaLayer>
      <DomainPanels search={domains} host={overlay} />
    </>
  );
}
