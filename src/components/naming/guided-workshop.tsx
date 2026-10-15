"use client";

import { useMemo, useState, type KeyboardEvent } from "react";
import { NamesArtwork } from "@/components/ui/names-artwork";
import { contextSnapshotSchema } from "@/domain/projects";
import { addGuidedWords, emptyGuidedUi, prefixChoices, previewGuidedNames, suffixChoices, tweakChoices, type GuidedUi } from "./guided-names";
import { useNamesActions } from "./use-names-store";
import type { NameCandidate, NamesMutationResult, NamesUi } from "./local-names";
import { ContextEditor } from "./workshop-panel";
import "./guided-workshop.css";

const modes = [{ value: "affixes", label: "Affix" }, { value: "tweaks", label: "Tweaks" }, { value: "blend", label: "Blend" }, { value: "swap", label: "Swap" }] as const;
export function GuidedWorkshop({ ui, candidates, onResult }: { ui: NamesUi; candidates: NameCandidate[]; onResult: (result: NamesMutationResult, success: string) => void }) {
  const namesStore = useNamesActions();
  const settings = ui.guided ?? emptyGuidedUi();
  const [error, setError] = useState("");
  const [copyNotice, setCopyNotice] = useState("");
  const preview = useMemo(() => previewGuidedNames(settings), [settings]);
  function patch(change: Partial<GuidedUi>) { setError(""); setCopyNotice(""); namesStore.updateUi({ guided: { ...settings, ...change } }); }
  function chooseMode(mode: GuidedUi["mode"]) {
    try { patch({ ...addGuidedWords(settings), mode }); }
    catch { setError("Use up to 300 unique words, each no longer than 160 characters. Remove invalid characters before adding them."); }
  }
  function commitWords() {
    try { const next = addGuidedWords(settings); const result = namesStore.updateUi({ guided: next }); if (!result.ok) setError(result.error ?? "Words could not be added."); return result.ok ? next : null; }
    catch { setError("Use up to 300 unique words, each no longer than 160 characters. Remove invalid characters before adding them."); return null; }
  }
  function saveWords() {
    const next = commitWords(); if (!next?.words.length) return;
    if (next.savedLists.length >= 20) { setError("Your 20 saved word lists are preserved. Remove a list or download your workspace before saving another."); return; }
    const result = namesStore.updateUi({ guided: { ...next, savedLists: [...next.savedLists, { id: crypto.randomUUID(), words: structuredClone(next.words), context: contextSnapshotSchema.parse(ui.context), createdAt: new Date().toISOString() }] } });
    onResult(result, "Word list saved. Find it in Saved.");
  }
  function modeKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? modes.length - 1 : (index + (event.key === "ArrowRight" ? 1 : modes.length - 1)) % modes.length;
    chooseMode(modes[next]!.value); document.getElementById(`names-mode-${modes[next]!.value}`)?.focus();
  }
  async function copyAll() {
    try { if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable"); await navigator.clipboard.writeText(preview.results.map(result => result.value).join("\n")); setCopyNotice("Results copied."); }
    catch { setCopyNotice("Copy is unavailable in this browser. Select the result text to copy it."); }
  }
  function affixPanel(side: "prefixes" | "suffixes") {
    const singular = side === "prefixes" ? "prefix" : "suffix", choices = side === "prefixes" ? prefixChoices : suffixChoices;
    const customKey = side === "prefixes" ? "customPrefixes" : "customSuffixes", rows = settings[customKey];
    const selected = settings[side];
    return <section className="names-guided-card names-affix-card" aria-label={`${singular} choices`}><header><h2>{singular === "prefix" ? "Prefix" : "Suffix"}</h2><p>Put text {singular === "prefix" ? "in front of" : "after"} each word.</p></header>
      <div className="names-affix-options"><button type="button" className="names-select-all" aria-pressed={choices.every(choice => selected.includes(choice))} onClick={() => patch({ [side]: choices.every(choice => selected.includes(choice)) ? [] : [...choices] })}>Select all<span className="sr-only"> {side}</span></button>{choices.map(choice => <button type="button" aria-label={`${singular} ${choice}`} aria-pressed={selected.includes(choice)} key={choice} onClick={() => patch({ [side]: selected.includes(choice) ? selected.filter(value => value !== choice) : [...selected, choice] })}>{choice}</button>)}</div>
      <div className="names-custom-affixes"><span>Custom</span>{rows.map((value, index) => <div className="names-custom-affix-row" key={index}><input aria-label={`Custom ${singular} ${index + 1}`} placeholder={singular === "prefix" ? "Mc" : "son"} value={value} maxLength={160} onChange={event => patch({ [customKey]: rows.map((row, i) => i === index ? event.target.value : row) })} /><button type="button" aria-label={`Remove custom ${singular} ${index + 1}`} onClick={() => patch({ [customKey]: rows.length === 1 ? [""] : rows.filter((_, i) => i !== index) })}><NamesArtwork name="x" /></button></div>)}<button type="button" className="names-guided-action" disabled={rows.length >= 12} onClick={() => patch({ [customKey]: [...rows, ""] })}><NamesArtwork name="plus" />Add {singular}</button></div>
      <p className="names-affix-hint">Each word is listed once per {singular}. They are not stacked.</p>
    </section>;
  }
  const byValue = new Map<string, NameCandidate[]>();
  for (const candidate of candidates) byValue.set(candidate.source.value, [...(byValue.get(candidate.source.value) ?? []), candidate]);
  const currentContext = contextSnapshotSchema.parse(ui.context);
  const heading = settings.mode === "blend" ? "Blends" : settings.mode === "swap" ? "Swaps" : "Results";
  return <div className="names-guided-workshop" data-mode={settings.mode}>
    <section className="names-guided-card names-words-panel" aria-label="Words"><header><h2>Words</h2><div><button type="button" className="names-guided-action" disabled={!settings.words.length && !settings.draft.trim()} onClick={saveWords}>Save</button><button type="button" className="names-guided-clear" disabled={!settings.words.length && !settings.draft} onClick={() => patch({ words: [], draft: "" })}>Clear</button></div></header><div className="names-words-input"><div className="names-word-chips">{settings.words.map(word => <span className="names-word-chip" key={word.value} title={word.candidateId ? "Retained name; captured context and history stay attached" : "Entered word"}><span>{word.value}</span><button type="button" aria-label={`Remove word ${word.value}`} onClick={() => patch({ words: settings.words.filter(item => item.value !== word.value) })}><NamesArtwork name="x" /></button></span>)}</div><input id="names-guided-word" aria-label="Add words" placeholder="Add another word…" value={settings.draft} maxLength={3000} onChange={event => patch({ draft: event.target.value })} onKeyDown={event => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); commitWords(); } }} /></div><p>Press Enter to add a word.</p></section>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="names-transformation-tabs" role="tablist" aria-label="Name transformations">{modes.map((mode, index) => <button type="button" role="tab" id={`names-mode-${mode.value}`} key={mode.value} aria-selected={settings.mode === mode.value} aria-controls="names-guided-panel" tabIndex={settings.mode === mode.value ? 0 : -1} onKeyDown={event => modeKey(event, index)} onClick={() => chooseMode(mode.value)}>{mode.label}</button>)}</div>
    <section className="names-guided-content" role="tabpanel" id="names-guided-panel" aria-labelledby={`names-mode-${settings.mode}`}>
      {settings.mode === "affixes" && <div className="names-affix-columns">{affixPanel("prefixes")}{affixPanel("suffixes")}</div>}
      {settings.mode === "tweaks" && <div className="names-tweak-cards">{tweakChoices.map(tweak => <button type="button" key={tweak.id} className="names-guided-card names-tweak-card" aria-pressed={settings.tweaks.includes(tweak.id)} aria-label={tweak.label} onClick={() => patch({ tweaks: settings.tweaks.includes(tweak.id) ? settings.tweaks.filter(id => id !== tweak.id) : [...settings.tweaks, tweak.id] })}><h3><NamesArtwork name={tweak.icon} />{tweak.label}</h3><p>{tweak.description}</p><span>{tweak.example}</span></button>)}</div>}
      {(settings.mode === "affixes" || settings.mode === "tweaks") && <section className="names-guided-card names-transform-order"><h3>Order</h3><p>Turn a tweak on. It runs on every word, live.</p><p>Tweaks run from top to bottom, one word at a time. Original capitalization is preserved except when changing case.</p>{settings.tweaks.length > 0 && <p className="names-active-order">{tweakChoices.filter(tweak => settings.tweaks.includes(tweak.id)).map(tweak => tweak.label).join(" → ")}</p>}</section>}
      {settings.mode === "blend" && <section className="names-guided-card names-blend-intro"><h2>Blend words</h2><p>Combine the beginning of one word with the end of another, joining shared letters where they overlap. Each pair is tried in both directions, live.</p><strong>smoke + fog → smog</strong><p>Uses your original words. Affixes and tweaks are kept for the other tabs. Spaces and punctuation are ignored; duplicate names appear once.</p></section>}
      {settings.mode === "swap" && <section className="names-guided-card names-swap-intro"><h2>Letter Swap</h2><p>Change one part of each word to explore new spellings.</p><div role="group" aria-label="Swap creativity">{(["safe", "balanced", "creative"] as const).map(level => <button type="button" className="names-guided-action" key={level} aria-pressed={settings.swapLevel === level} onClick={() => patch({ swapLevel: level })}>{level[0]!.toUpperCase() + level.slice(1)}</button>)}</div><p>Safe stays closest to your words. Creative explores more variations. Swaps use your original words, without affixes or other tweaks.</p></section>}
      <section className="names-guided-results" aria-label="Live naming results"><header><h2>{heading}</h2><button type="button" className="names-guided-action" disabled={!preview.results.length} onClick={() => void copyAll()}><NamesArtwork name="copy" />Copy all</button></header>{settings.mode === "blend" && <p>Showing up to 300 blends from the first 300 entries.</p>}<div className="names-result-pills">{preview.results.map(result => {
        const parent = candidates.find(candidate => candidate.source.id === result.seed.candidateId);
        const context = parent?.context ?? currentContext;
        const recipe = [...(parent?.source.history.map(step => step.input) ?? []), ...result.inputs];
        const kept = byValue.get(result.value)?.find(candidate => JSON.stringify(candidate.context) === JSON.stringify(context) && JSON.stringify(candidate.source.history.map(step => step.input)) === JSON.stringify(recipe) && (parent?.source.history.every((step, i) => JSON.stringify(candidate.source.history[i]) === JSON.stringify(step)) ?? true));
        return <div key={result.value} className={`names-result-pill${settings.mode === "blend" ? " names-blend-pill" : ""}`}><div><strong>{result.value}</strong>{settings.mode === "blend" && <span>{result.origin}</span>}</div><button type="button" aria-label={`Favorite result ${result.value}`} aria-pressed={kept?.favorite ?? false} onClick={() => onResult(namesStore.retainGuidedResult(result), kept?.favorite ? "Favorite removed; its name and history remain." : "Name favorited with its source and exact history.")}><NamesArtwork name="heart" /></button></div>;
      })}</div>{!preview.results.length && <p className="names-guided-empty">{settings.words.length ? settings.mode === "blend" ? "Add a second distinct word to explore blends." : "No valid variants with these settings. Your words are unchanged." : "Add your own words to see results."}</p>}{preview.truncated && <p role="status">This preview reached its limit. Narrow the words or options to explore more results.</p>}{preview.omitted > 0 && <p>{preview.omitted} empty, unchanged or oversized combinations omitted.</p>}{copyNotice && <p role="status">{copyNotice}</p>}</section>
    </section>
    <div className="names-guided-support"><ContextEditor ui={ui} /><p>Live previews run on this device. Favoriting keeps a name and its exact transformation history in your account. Availability and trademark clearance are not checked.</p></div>
  </div>;
}

export function SavedWordLists({ ui, onResult }: { ui: NamesUi; onResult: (result: NamesMutationResult, success: string) => void }) {
  const namesStore = useNamesActions();
  const settings = ui.guided ?? emptyGuidedUi();
  return <section className="names-saved-word-lists" aria-label="Saved word lists"><h2>Saved word lists</h2><p>Word lists save to your account. Kept names are available in Library.</p>{settings.savedLists.length ? settings.savedLists.map(list => <article className="names-guided-card" key={list.id}><h3>{list.words[0]!.value}{list.words.length > 1 ? ` + ${list.words.length - 1}` : ""}</h3><p>{list.words.map(word => word.value).join(", ")}</p><div><button type="button" className="button secondary small" onClick={() => onResult(namesStore.useGuidedWordList(list.id), "Saved words restored.")}>Use words</button><button type="button" className="text-link" onClick={() => namesStore.updateUi({ guided: { ...settings, savedLists: settings.savedLists.filter(item => item.id !== list.id) } })}>Remove word list<span className="sr-only"> {list.words[0]!.value}</span></button></div></article>) : <p>No saved word lists yet. Save the Words panel to revisit a list.</p>}</section>;
}
