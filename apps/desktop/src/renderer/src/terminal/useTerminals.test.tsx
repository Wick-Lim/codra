import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  CodraDesktopApi,
  TerminalDescriptor,
  TerminalOutputChunk,
} from "@codra/protocol";
import { describe, expect, it, vi } from "vitest";
import { useTerminals } from "./useTerminals";

const firstTerminal: TerminalDescriptor = {
  id: "2a1e20df-860f-4f29-a2c3-b2f28d44c2e5",
  title: "api",
  cwd: "/workspace/services/api",
  cols: 100,
  rows: 30,
  state: "running",
  createdAt: "2026-08-01T00:00:00.000Z",
};

const secondTerminal: TerminalDescriptor = {
  id: "ba040703-89de-4147-8773-8e86ec5e7e13",
  title: "tests",
  cwd: "/workspace",
  cols: 100,
  rows: 30,
  state: "running",
  createdAt: "2026-08-01T00:01:00.000Z",
};

function createDesktopApiFake() {
  let outputListener: ((chunk: TerminalOutputChunk) => void) | undefined;
  let changedListener: ((descriptor: TerminalDescriptor) => void) | undefined;
  const stopOutput = vi.fn();
  const stopChanged = vi.fn();

  const api: CodraDesktopApi = {
    terminal: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      write: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined),
      replay: vi.fn().mockResolvedValue([]),
      close: vi.fn().mockResolvedValue(undefined),
      onOutput: vi.fn((listener) => {
        outputListener = listener;
        return stopOutput;
      }),
      onChanged: vi.fn((listener) => {
        changedListener = listener;
        return stopChanged;
      }),
    },
  };

  return {
    api,
    emitOutput(chunk: TerminalOutputChunk) {
      outputListener?.(chunk);
    },
    emitChanged(descriptor: TerminalDescriptor) {
      changedListener?.(descriptor);
    },
    stopOutput,
    stopChanged,
  };
}

describe("useTerminals", () => {
  it("subscribes before loading and keeps events received during the initial load", async () => {
    const fake = createDesktopApiFake();
    let finishList: ((terminals: TerminalDescriptor[]) => void) | undefined;
    vi.mocked(fake.api.terminal.list).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishList = resolve;
        }),
    );

    const { result } = renderHook(() => useTerminals(fake.api));

    expect(fake.api.terminal.onOutput).toHaveBeenCalledOnce();
    expect(fake.api.terminal.onChanged).toHaveBeenCalledOnce();
    expect(fake.api.terminal.list).toHaveBeenCalledOnce();

    act(() => {
      fake.emitChanged({ ...firstTerminal, title: "api — ready" });
      fake.emitOutput({
        terminalId: firstTerminal.id,
        sequence: 1,
        data: "$ ",
      });
      finishList?.([firstTerminal]);
    });

    await waitFor(() => {
      expect(result.current.terminals[0]?.title).toBe("api — ready");
    });
    expect(result.current.output.get(firstTerminal.id)).toEqual([
      { terminalId: firstTerminal.id, sequence: 1, data: "$ " },
    ]);
  });

  it("selects the first running terminal from the initial load", async () => {
    const fake = createDesktopApiFake();
    vi.mocked(fake.api.terminal.list).mockResolvedValue([
      { ...firstTerminal, state: "exited", exitCode: 0 },
      secondTerminal,
    ]);

    const { result } = renderHook(() => useTerminals(fake.api));

    await waitFor(() => {
      expect(result.current.activeTerminalId).toBe(secondTerminal.id);
    });
    expect(fake.api.terminal.list).toHaveBeenCalledOnce();
  });

  it("creates a 100 by 30 terminal and selects it", async () => {
    const fake = createDesktopApiFake();
    vi.mocked(fake.api.terminal.create).mockResolvedValue(secondTerminal);
    const { result } = renderHook(() => useTerminals(fake.api));

    await act(async () => {
      await result.current.createTerminal();
    });

    expect(fake.api.terminal.create).toHaveBeenCalledWith({
      cols: 100,
      rows: 30,
    });
    expect(result.current.terminals).toEqual([secondTerminal]);
    expect(result.current.activeTerminalId).toBe(secondTerminal.id);
  });

  it("selects and closes terminals without discarding an exited descriptor", async () => {
    const fake = createDesktopApiFake();
    vi.mocked(fake.api.terminal.list).mockResolvedValue([
      firstTerminal,
      secondTerminal,
    ]);
    const { result } = renderHook(() => useTerminals(fake.api));
    await waitFor(() => expect(result.current.terminals).toHaveLength(2));

    act(() => result.current.selectTerminal(secondTerminal.id));
    expect(result.current.activeTerminalId).toBe(secondTerminal.id);

    await act(async () => {
      await result.current.closeTerminal(secondTerminal.id);
    });
    act(() => {
      fake.emitChanged({ ...secondTerminal, state: "exited", exitCode: 0 });
    });

    expect(fake.api.terminal.close).toHaveBeenCalledWith(secondTerminal.id);
    expect(result.current.terminals).toContainEqual({
      ...secondTerminal,
      state: "exited",
      exitCode: 0,
    });
    expect(result.current.activeTerminalId).toBe(secondTerminal.id);
  });

  it("replaces changed descriptors and deduplicates output in sequence order", async () => {
    const fake = createDesktopApiFake();
    vi.mocked(fake.api.terminal.list).mockResolvedValue([firstTerminal]);
    const { result } = renderHook(() => useTerminals(fake.api));
    await waitFor(() => expect(result.current.terminals).toHaveLength(1));

    act(() => {
      fake.emitChanged({
        ...firstTerminal,
        title: "server",
        cwd: "/workspace/server",
        state: "exited",
        exitCode: 143,
      });
      fake.emitOutput({
        terminalId: firstTerminal.id,
        sequence: 2,
        data: "second",
      });
      fake.emitOutput({
        terminalId: firstTerminal.id,
        sequence: 1,
        data: "first",
      });
      fake.emitOutput({
        terminalId: firstTerminal.id,
        sequence: 2,
        data: "duplicate",
      });
    });

    expect(result.current.terminals).toEqual([
      {
        ...firstTerminal,
        title: "server",
        cwd: "/workspace/server",
        state: "exited",
        exitCode: 143,
      },
    ]);
    expect(
      result.current.output.get(firstTerminal.id)?.map((chunk) => chunk.data),
    ).toEqual(["first", "second"]);
  });

  it("unsubscribes from terminal events on unmount", () => {
    const fake = createDesktopApiFake();
    const { unmount } = renderHook(() => useTerminals(fake.api));

    unmount();

    expect(fake.stopOutput).toHaveBeenCalledOnce();
    expect(fake.stopChanged).toHaveBeenCalledOnce();
  });
});
