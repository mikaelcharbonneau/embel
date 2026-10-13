"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { z } from "zod";
import { localChatGPTModelsSchema, localChatGPTStatusSchema, localSignInResponseSchema, localSignOutResponseSchema, type LocalChatGPTStatus } from "@/domain/local-chatgpt";
import { accountRequest, AccountRequestError } from "./account-api";
import { useAccountSession, type VerifiedAccount } from "./account-session";
import "@/styles/local-chatgpt.css";

type Catalog = z.infer<typeof localChatGPTModelsSchema>;
function connectionError(error: unknown) {
  if (error instanceof AccountRequestError) {
    if (error.status === 502) return "The local connection response could not be verified.";
    if (error.status === 403) return "This connection action is not currently allowed. Check connection status.";
    if (error.status === 409) return "The connection changed. Check its status before trying again.";
    if (error.status === 422) return "Choose a connection and a model from its available catalog.";
    if (error.status === 404 || error.status === 503) return "The local ChatGPT service is unavailable. Check that Embel is running on this Mac.";
  }
  return "The local connection request could not be confirmed. Check connection status before trying again.";
}

export function LocalChatGPTSettings({ enabled = false }: { enabled?: boolean }) {
  const { session } = useAccountSession();
  if (!enabled) return null;
  return <section className="settings-section local-chatgpt-settings" aria-labelledby="local-chatgpt-heading"><div><h2 id="local-chatgpt-heading">ChatGPT on this Mac</h2><p>Text and strategy can use your ChatGPT plan. Your Embel account owns your saved projects.</p></div><div className="settings-panel">
    {session.status === "ready" ? <LocalConnection key={`${session.userId}:${session.generation}`} account={session} /> : <div className="setting-row"><div><strong>Sign in to Embel first</strong><p>Verify your Embel account to manage its local ChatGPT connection.</p></div><Link className="button secondary small" href="/sign-in">Sign in to Embel</Link></div>}
  </div></section>;
}

function LocalConnection({ account }: { account: VerifiedAccount }) {
  const { isCurrent, expire } = useAccountSession();
  const [status, setStatus] = useState<LocalChatGPTStatus | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [registrationChoice, setRegistrationChoice] = useState<string | undefined>();
  const [modelChoice, setModelChoice] = useState<string | undefined>();
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [readVersion, setReadVersion] = useState(0);
  const live = useRef(false);
  const mutation = useRef<AbortController | null>(null);
  const epoch = useRef(0);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; mutation.current?.abort(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const startedEpoch = epoch.current;
    void accountRequest("/api/local/chatgpt/status", localChatGPTStatusSchema, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted && live.current && isCurrent(account) && startedEpoch === epoch.current) { setStatus(value); setReadError(null); }
    }).catch((error: unknown) => {
      if (controller.signal.aborted || !live.current || !isCurrent(account) || startedEpoch !== epoch.current) return;
      if (error instanceof AccountRequestError && error.status === 401) expire(account);
      else { setStatus(null); setReadError(connectionError(error)); }
    });
    return () => controller.abort();
  }, [account, expire, isCurrent, readVersion]);

  const registrationId = registrationChoice ?? status?.selectedRegistrationId ?? "";
  const registration = status?.registrations.find(item => item.registrationId === registrationId);
  const models = catalog?.registrationId === registrationId ? catalog.models : [];
  const model = modelChoice ?? (status?.selectedRegistrationId === registrationId ? status.model ?? "" : "");
  const savedRegistration = status?.registrations.find(item => item.registrationId === status.selectedRegistrationId);
  const ready = Boolean(status?.workerReady && status.model && savedRegistration?.planUsageEnabled);
  const refresh = () => { setReadVersion(value => value + 1); };
  function begin(label: string) {
    if (!live.current || !isCurrent(account) || mutation.current) return null;
    const controller = new AbortController(); mutation.current = controller; epoch.current += 1;
    setPending(label); setActionError(null); setNotice(null); return controller;
  }
  function current(controller: AbortController) { return live.current && mutation.current === controller && !controller.signal.aborted && isCurrent(account); }
  function fail(error: unknown, controller: AbortController) {
    if (!current(controller)) return;
    if (error instanceof AccountRequestError && error.status === 401) expire(account);
    else setActionError(connectionError(error));
  }
  function finish(controller: AbortController) {
    if (mutation.current === controller) { mutation.current = null; if (live.current) setPending(null); }
  }
  async function loadModels() {
    if (!status?.connectionAllowed || !registration) return;
    const controller = begin("Loading available models…"); if (!controller) return;
    try {
      const value = await accountRequest("/api/local/chatgpt/models", localChatGPTModelsSchema, { method: "POST", body: { registrationId }, signal: controller.signal });
      if (!current(controller)) return;
      if (value.registrationId !== registrationId) throw new AccountRequestError(502);
      setCatalog(value);
    } catch (error: unknown) { fail(error, controller); }
    finally { finish(controller); }
  }
  async function saveSelection() {
    if (!status?.connectionAllowed || !registration?.planUsageEnabled || !models.some(item => item.slug === model)) return;
    const controller = begin("Saving your text connection…"); if (!controller) return;
    try {
      const value = await accountRequest("/api/local/chatgpt/select-model", localChatGPTStatusSchema, { method: "POST", body: { registrationId, model }, signal: controller.signal });
      if (!current(controller)) return;
      if (value.selectedRegistrationId !== registrationId || value.model !== model || !value.registrations.some(item => item.registrationId === registrationId)) throw new AccountRequestError(502);
      setStatus(value); setReadError(null); setNotice("Text connection saved. Your ChatGPT plan limits apply.");
    } catch (error: unknown) { fail(error, controller); }
    finally { finish(controller); }
  }
  async function signIn(reconnect = false) {
    if (!status?.connectionAllowed || (reconnect && !registration)) return;
    const controller = begin("Opening ChatGPT sign-in…"); if (!controller) return;
    try {
      const value = await accountRequest("/api/local/chatgpt/sign-in", localSignInResponseSchema, { method: "POST", body: reconnect ? { registrationId } : {}, signal: controller.signal });
      if (current(controller)) window.location.assign(value.authorizationUrl);
    } catch (error: unknown) { fail(error, controller); }
    finally { finish(controller); }
  }
  async function disconnect() {
    if (!registration) return;
    const controller = begin("Disconnecting ChatGPT…"); if (!controller) return;
    try {
      const result = await accountRequest("/api/local/chatgpt/sign-out", localSignOutResponseSchema, { method: "POST", body: { registrationId }, signal: controller.signal });
      if (!current(controller)) return;
      setNotice(result.remoteRevocationConfirmed ? "Disconnected from Embel on this Mac. Remote access was revoked." : "Disconnected from Embel on this Mac. Remote revocation could not be confirmed.");
      setStatus(null); setCatalog(null); setRegistrationChoice(undefined); setModelChoice(undefined); refresh();
    } catch (error: unknown) { fail(error, controller); }
    finally { finish(controller); }
  }

  return <>
    <div className="setting-row"><div><strong>{status ? ready ? "Ready for text requests" : "Choose a ChatGPT connection for text requests." : readError ? "Connection status unavailable" : "Checking local connection…"}</strong><p>{status?.selectedRegistrationId && status.model ? `Saved text model: ${models.find(item => item.slug === status.model)?.displayName ?? status.model}. ${ready ? "Your ChatGPT plan limits apply." : "The text worker is not ready yet."}` : "Available models come from your selected ChatGPT connection."}</p></div><button type="button" className="button secondary small" disabled={Boolean(pending)} onClick={refresh}>Check connection status</button></div>
    {status && <>
      <div className="setting-row"><div><strong>Connect ChatGPT</strong><p>{status.connectionAllowed ? "Continue to ChatGPT to review access for Embel on this Mac." : "Connection approval is required before ChatGPT sign-in can open."}</p></div><button type="button" className="button secondary small" disabled={!status.connectionAllowed || Boolean(pending)} onClick={() => void signIn()}>Continue with ChatGPT</button></div>
      {status.registrations.length > 0 && <>
        <div className="setting-row"><div><label className="field-label">ChatGPT connection<select value={registration ? registrationId : ""} disabled={Boolean(pending)} onChange={event => { setRegistrationChoice(event.target.value); setModelChoice(undefined); setCatalog(null); setActionError(null); setNotice(null); }}><option value="">Choose a connection</option>{status.registrations.map((item, index) => <option key={item.registrationId} value={item.registrationId}>{item.email || `ChatGPT connection ${index + 1}`}</option>)}</select></label>{registration && !registration.planUsageEnabled && <p>This connection has not enabled ChatGPT plan usage.</p>}</div><button type="button" className="button secondary small" disabled={!status.connectionAllowed || !registration || Boolean(pending)} onClick={() => void loadModels()}>Load available models</button></div>
        {registration && catalog?.registrationId === registrationId && <div className="setting-row"><div><label className="field-label">Text model<select value={model} disabled={Boolean(pending) || !status.connectionAllowed} onChange={event => setModelChoice(event.target.value)}><option value="">Choose a model</option>{models.map(item => <option key={item.slug} value={item.slug}>{item.displayName}</option>)}</select></label>{models.length === 0 && <p>No models are available for this connection.</p>}{status.selectedRegistrationId && (registrationId !== status.selectedRegistrationId || model !== status.model) && <p>Changing the model stops requests using the previous selection. Send a new message to start with the new model.</p>}</div><button type="button" className="button primary small" disabled={!status.connectionAllowed || Boolean(pending) || !registration.planUsageEnabled || !models.some(item => item.slug === model)} onClick={() => void saveSelection()}>Save text connection</button></div>}
        {registration && <div className="setting-row"><div><strong>Manage this connection</strong><p>Disconnecting stops Embel from using this ChatGPT connection.</p></div><div className="account-recovery-actions">{!registration.planUsageEnabled && <button type="button" className="button secondary small" disabled={!status.connectionAllowed || Boolean(pending)} onClick={() => void signIn(true)}>Reconnect ChatGPT</button>}<button type="button" className="button secondary small" disabled={Boolean(pending)} onClick={() => void disconnect()}>Disconnect ChatGPT</button></div></div>}
      </>}
      <div className="setting-row"><div><strong>Images</strong><p>Image generation is unavailable. An approved spending limit is required.</p></div><span className="small-badge">Unavailable</span></div>
    </>}
    {pending && <p className="field-hint" role="status">{pending}</p>}
    {(readError || actionError) && <p className="form-error" role="alert">{actionError ?? readError}</p>}
    {notice && <p className="form-success" role="status">{notice}</p>}
  </>;
}
