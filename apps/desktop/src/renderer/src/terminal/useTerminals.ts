import type {
  CodraDesktopApi,
  TerminalDescriptor,
  TerminalOutputChunk,
} from "@codra/protocol";
import { useCallback, useEffect, useMemo, useState } from "react";

export interface UseTerminalsResult {
  terminals: TerminalDescriptor[];
  activeTerminalId: string | null;
  activeTerminal: TerminalDescriptor | null;
  output: ReadonlyMap<string, readonly TerminalOutputChunk[]>;
  createTerminal(): Promise<void>;
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
  const [output, setOutput] = useState<
    ReadonlyMap<string, readonly TerminalOutputChunk[]>
  >(new Map());

  useEffect(() => {
    let mounted = true;
    const changedDuringLoad = new Map<string, TerminalDescriptor>();

    const stopOutput = api.terminal.onOutput((chunk) => {
      if (!mounted) return;
      setOutput((current) => {
        const terminalOutput = current.get(chunk.terminalId) ?? [];
        if (
          terminalOutput.some(({ sequence }) => sequence === chunk.sequence)
        ) {
          return current;
        }

        const next = new Map(current);
        next.set(
          chunk.terminalId,
          [...terminalOutput, chunk].sort(
            (left, right) => left.sequence - right.sequence,
          ),
        );
        return next;
      });
    });
    const stopChanged = api.terminal.onChanged((descriptor) => {
      if (!mounted) return;
      changedDuringLoad.set(descriptor.id, descriptor);
      setTerminals((current) => replaceDescriptor(current, descriptor));
    });

    void api.terminal.list().then((listed) => {
      if (!mounted) return;
      const loaded = listed.map(
        (descriptor) => changedDuringLoad.get(descriptor.id) ?? descriptor,
      );
      for (const changed of changedDuringLoad.values()) {
        if (!loaded.some(({ id }) => id === changed.id)) loaded.push(changed);
      }
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
      stopOutput();
      stopChanged();
    };
  }, [api]);

  const createTerminal = useCallback(async () => {
    const descriptor = await api.terminal.create({ cols: 100, rows: 30 });
    setTerminals((current) => replaceDescriptor(current, descriptor));
    setActiveTerminalId(descriptor.id);
  }, [api]);

  const selectTerminal = useCallback((terminalId: string) => {
    setActiveTerminalId(terminalId);
  }, []);

  const closeTerminal = useCallback(
    async (terminalId: string) => {
      await api.terminal.close(terminalId);
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
    output,
    createTerminal,
    selectTerminal,
    closeTerminal,
  };
}
