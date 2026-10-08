"use client";

import { createContext, createElement, useContext, type ReactNode } from "react";
import type { LogoDraftMemory } from "./logo-draft-memory";

const LogoDraftContext = createContext<LogoDraftMemory | null>(null);

export function LogoDraftMemoryProvider({ memory, children }: { memory: LogoDraftMemory; children: ReactNode }): React.JSX.Element {
  return createElement(LogoDraftContext.Provider, { value: memory }, children);
}
export function useLogoDraftMemory(): LogoDraftMemory {
  const memory = useContext(LogoDraftContext);
  if (!memory) throw new Error("Logo draft memory provider is required.");
  return memory;
}
