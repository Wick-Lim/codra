import type {
  AgentLaunchRequest,
  AgentSetupRequest,
  AgentSetupResult,
  CodraDesktopApi,
  TerminalDescriptor,
} from "@codra/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface UseTerminalsResult {
  terminals: TerminalDescriptor[];
  activeTerminalId: string | null;
  activeTerminal: TerminalDescriptor | null;
  defaultCwd: string;
  chooseCwd(defaultPath: string): Promise<string | null>;
  createTerminal(): Promise<void>;
  createAgent(request: AgentLaunchRequest, cwd: string): Promise<void>;
  setupAgent(request: AgentSetupRequest): Promise<AgentSetupResult>;
  selectTerminal(terminalId: string): void;
  closeTerminal(terminalId: string): Promise<void>;
}

function replaceDescriptor(
  descriptors: TerminalDescriptor[],
  replacement: TerminalDescriptor,
): TerminalDescriptor[] {
  const index = descriptors.findIndex(
    (descriptor) => descriptor.id === replacement.id,
  );
  if (index === -1) return [...descriptors, replacement];

  const next = [...descriptors];
  next[index] = replacement;
  return next;
}

export function useTerminals(
  api: CodraDesktopApi = window.codra,
): UseTerminalsResult {
  const [terminals, setTerminals] = useState<TerminalDescriptor[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [defaultCwd, setDefaultCwd] = useState("");
  const dismissedTerminalIds = useRef(new Set<string>());

  useEffect(() => {
    let mounted = true;
    let initialLoadPending = true;
    const changedDuringLoad = new Map<string, TerminalDescriptor>();

    const stopChanged = api.terminal.onChanged((descriptor) => {
      if (!mounted) return;
      if (dismissedTerminalIds.current.has(descriptor.id)) return;
      if (initialLoadPending) changedDuringLoad.set(descriptor.id, descriptor);
      setTerminals((current) => replaceDescriptor(current, descriptor));
    });

    void api.terminal
      .defaultCwd()
      .then((cwd) => {
        if (mounted) setDefaultCwd(cwd);
      })
      .catch(() => undefined);

    void api.terminal.list().then((listed) => {
      if (!mounted) return;
      const loaded = listed.flatMap((descriptor) => {
        if (dismissedTerminalIds.current.has(descriptor.id)) return [];
        const changed = changedDuringLoad.get(descriptor.id);
        const current = changed ?? descriptor;
        return current.state === "exited" && !changed ? [] : [current];
      });
      for (const changed of changedDuringLoad.values()) {
        if (dismissedTerminalIds.current.has(changed.id)) continue;
        if (!loaded.some(({ id }) => id === changed.id)) loaded.push(changed);
      }
      initialLoadPending = false;
      changedDuringLoad.clear();
      setTerminals(loaded);
      setActiveTerminalId(
        (current) =>
          current ??
          loaded.find(({ state }) => state === "running")?.id ??
          null,
      );
    });

    return () => {
      mounted = false;
      stopChanged();
    };
  }, [api]);

  useEffect(() => {
    setActiveTerminalId((current) => {
      if (current && terminals.some(({ id }) => id === current)) return current;
      return (
        terminals.find(({ state }) => state === "running")?.id ??
        terminals[0]?.id ??
        null
      );
    });
  }, [terminals]);

  const createTerminal = useCallback(async () => {
    const descriptor = await api.terminal.create({ cols: 100, rows: 30 });
    setTerminals((current) => replaceDescriptor(current, descriptor));
    setActiveTerminalId(descriptor.id);
  }, [api]);

  const chooseCwd = useCallback(
    (defaultPath: string) => api.terminal.chooseCwd(defaultPath),
    [api],
  );

  const createAgent = useCallback(
    async (agent: AgentLaunchRequest, cwd: string) => {
      const descriptor = await api.terminal.create({
        cols: 100,
        rows: 30,
        cwd,
        agent,
      });
      setTerminals((current) => replaceDescriptor(current, descriptor));
      setActiveTerminalId(descriptor.id);
    },
    [api],
  );

  const setupAgent = useCallback(
    async (request: AgentSetupRequest): Promise<AgentSetupResult> => {
      const result = await api.agents.setup(request);
      if (result.kind === "terminal") {
        setTerminals((current) => replaceDescriptor(current, result.terminal));
        setActiveTerminalId(result.terminal.id);
      }
      return result;
    },
    [api],
  );

  const selectTerminal = useCallback((terminalId: string) => {
    setActiveTerminalId(terminalId);
  }, []);

  const closeTerminal = useCallback(
    async (terminalId: string) => {
      await api.terminal.close(terminalId);
      dismissedTerminalIds.current.add(terminalId);
      setTerminals((current) => current.filter(({ id }) => id !== terminalId));
      setActiveTerminalId((current) =>
        current === terminalId ? null : current,
      );
    },
    [api],
  );

  const activeTerminal = useMemo(
    () => terminals.find(({ id }) => id === activeTerminalId) ?? null,
    [activeTerminalId, terminals],
  );

  return {
    terminals,
    activeTerminalId,
    activeTerminal,
    defaultCwd,
    chooseCwd,
    createTerminal,
    createAgent,
    setupAgent,
    selectTerminal,
    closeTerminal,
  };
}
