'use client';
import { useCallback, useMemo } from 'react';
import type { LogoWorkspaceV2 } from '@/domain/logo-workspace';
import { LogoInputsPanel, type LogoInputsPanelProps } from '@/features/logo-inputs/components/logo-inputs-panel';
import { type AccountLogoClient, isAccountLogoClientCurrent } from './account-logo-client';
import { useAccountSession, type VerifiedAccount } from '../workspace/account-session';
import { createLogoInputHttpClient } from './logo-input-http';
type Props = {account:VerifiedAccount;workspace:LogoWorkspaceV2;client:AccountLogoClient;mode:'fonts'|'references';canWrite:boolean}
  & Pick<LogoInputsPanelProps,'selections'|'savedReferences'|'onSelectionsChange'>;
/** Real account transport and provider-lifetime file/request memory. */
export function AccountLogoInputs({account,workspace,client,canWrite,...view}:Props){
  const {isCurrent,expire,logoInputSession}=useAccountSession();
  const transport=useMemo(()=>createLogoInputHttpClient(client,account,workspace.projectId,isCurrent,expire),[client,account,workspace.projectId,isCurrent,expire]);
  const current=useCallback(()=>isCurrent(account)&&workspace.ownerId===account.userId&&isAccountLogoClientCurrent(client,account,workspace.projectId),[account,client,isCurrent,workspace.ownerId,workspace.projectId]);
  if(!current())return null;
  const props={...view,account,session:logoInputSession,client:transport,workspace,bindingKey:`${account.userId}:${account.generation}`,isCurrent:current,canWrite};
  return <LogoInputsPanel {...props}/>;
}
