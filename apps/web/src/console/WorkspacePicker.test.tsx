// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  WorkspaceDirectoryPage,
  WorkspaceRoot,
  WorkspaceSelection,
} from "@codra/protocol";
import { WorkspacePicker } from "./WorkspacePicker";
import { t } from "../i18n/messages";

// Vitest globals are off for this workspace, so Testing Library's automatic
// cleanup never registers itself. Unmount between cases explicitly.
afterEach(cleanup);

const copy = t.console.workspace;

const home: WorkspaceRoot = { path: "/Users/codra", label: "Home" };
const projects: WorkspaceRoot = {
  path: "/Users/codra/Projects",
  label: "Projects",
};

function page(
  path: string,
  label: string,
  entries: ReadonlyArray<{ path: string; name: string }>,
  breadcrumbs: readonly WorkspaceRoot[] = [{ path, label }],
): WorkspaceDirectoryPage {
  return { path, label, breadcrumbs: [...breadcrumbs], entries: [...entries] };
}

function harness(
  overrides: {
    roots?: () => Promise<WorkspaceRoot[]>;
    list?: (path: string) => Promise<WorkspaceDirectoryPage>;
    validate?: (path: string) => Promise<WorkspaceSelection>;
  } = {},
) {
  const roots = vi.fn(overrides.roots ?? (async () => [home, projects]));
  const list = vi.fn(
    overrides.list ??
      (async (path: string) =>
        path === home.path
          ? page(home.path, home.label, [
              { path: projects.path, name: "Projects" },
            ])
          : page(projects.path, projects.label, [], [home, projects])),
  );
  const validate = vi.fn(
    overrides.validate ??
      (async (path: string) => ({ path, label: "Projects" })),
  );
  const onSelect = vi.fn();
  render(
    <WorkspacePicker
      roots={roots}
      list={list}
      validate={validate}
      onSelect={onSelect}
    />,
  );
  return { roots, list, validate, onSelect };
}

describe("WorkspacePicker", () => {
  it("asks the host for its roots before it lists any directory", async () => {
    const { roots, list } = harness();

    expect(
      await screen.findByRole("button", { name: home.label }),
    ).toBeTruthy();
    expect(roots).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
  });

  it("browses from a root into a subdirectory", async () => {
    const { list } = harness();

    await userEvent.click(await screen.findByRole("button", { name: "Home" }));
    await userEvent.click(
      await screen.findByRole("button", { name: copy.open("Projects") }),
    );

    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(list.mock.calls.map(([path]) => path)).toEqual([
      home.path,
      projects.path,
    ]);
  });

  it("confirms the chosen directory through workspace.validate", async () => {
    const { validate, onSelect } = harness({
      validate: async () => ({ path: "/Users/codra", label: "Home" }),
    });

    await userEvent.click(await screen.findByRole("button", { name: "Home" }));
    await userEvent.click(
      await screen.findByRole("button", { name: copy.use(home.label) }),
    );

    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    expect(validate).toHaveBeenCalledWith(home.path);
    // The host's answer is what propagates, not the path that was browsed to.
    expect(onSelect).toHaveBeenCalledWith({
      path: "/Users/codra",
      label: "Home",
    });
  });

  it("keeps a rejected directory out of the session", async () => {
    const { onSelect } = harness({
      validate: async () => {
        throw new Error("WORKSPACE_PATH_DENIED");
      },
    });

    await userEvent.click(await screen.findByRole("button", { name: "Home" }));
    await userEvent.click(
      await screen.findByRole("button", { name: copy.use(home.label) }),
    );

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      copy.validateFailed,
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("reports a host that cannot list its roots", async () => {
    harness({
      roots: async () => {
        throw new Error("WORKSPACE_UNAVAILABLE");
      },
    });

    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      copy.rootsFailed,
    );
  });
});
