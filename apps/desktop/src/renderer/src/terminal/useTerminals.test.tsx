import { act, renderHook, waitFor } from "@testing-library/react";
import type { CodraDesktopApi, TerminalDescriptor } from "@codra/protocol";
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
  let changedListener: ((descriptor: TerminalDescriptor) => void) | undefined;
  const stopChanged = vi.fn();

  const api: CodraDesktopApi = {
    terminal: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      write: vi.fn().mockResolvedValue(undefined),
      resize: vi.fn().mockResolvedValue(undefined),
      replay: vi.fn().mockResolvedValue([]),
      close: vi.fn().mockResolvedValue(undefined),
      onOutput: vi.fn(() => vi.fn()),
      onChanged: vi.fn((listener) => {
        changedListener = listener;
        return stopChanged;
      }),
    },
    remote: {
      getState: vi.fn().mockResolvedValue({ state: "idle" }),
      getAuthState: vi.fn().mockResolvedValue({ state: "signed_out" }),
      login: vi.fn().mockResolvedValue({ state: "signed_in" }),
      activate: vi.fn().mockResolvedValue({ state: "online" }),
      deactivate: vi.fn().mockResolvedValue({ state: "idle" }),
      onStateChanged: vi.fn(() => vi.fn()),
      onAuthStateChanged: vi.fn(() => vi.fn()),
    },
  };

  return {
    api,
    emitChanged(descriptor: TerminalDescriptor) {
      changedListener?.(descriptor);
    },
    stopChanged,
  };
}

describe("useTerminals", () => {
  it("keeps descriptor events received during the initial load without subscribing to output", async () => {
    const fake = createDesktopApiFake();
    let finishList: ((terminals: TerminalDescriptor[]) => void) | undefined;
    vi.mocked(fake.api.terminal.list).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishList = resolve;
        }),
    );

    const { result } = renderHook(() => useTerminals(fake.api));

    expect(fake.api.terminal.onOutput).not.toHaveBeenCalled();
    expect(fake.api.terminal.onChanged).toHaveBeenCalledOnce();
    expect(fake.api.terminal.list).toHaveBeenCalledOnce();
    expect(
      vi.mocked(fake.api.terminal.onChanged).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(fake.api.terminal.list).mock.invocationCallOrder[0]!,
    );

    act(() => {
      fake.emitChanged({ ...firstTerminal, title: "api — ready" });
      finishList?.([firstTerminal]);
    });

    await waitFor(() => {
      expect(result.current.terminals[0]?.title).toBe("api — ready");
    });
    expect(result.current).not.toHaveProperty("output");
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

  it("replaces changed descriptors", async () => {
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
    expect(fake.api.terminal.onOutput).not.toHaveBeenCalled();
  });

  it("unsubscribes from terminal events on unmount", () => {
    const fake = createDesktopApiFake();
    const { unmount } = renderHook(() => useTerminals(fake.api));

    unmount();

    expect(fake.stopChanged).toHaveBeenCalledOnce();
  });
});
