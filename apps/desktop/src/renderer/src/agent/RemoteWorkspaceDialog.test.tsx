import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import type { RemoteAgentExecutionTarget } from "@codra/protocol";
import { RemoteWorkspaceDialog } from "./RemoteWorkspaceDialog";

void React;

const target: RemoteAgentExecutionTarget = {
  kind: "remote",
  deviceId: "40c77568-ae29-4af2-a57e-453ffc248a7b",
  displayName: "Studio Mac",
};

describe("RemoteWorkspaceDialog", () => {
  it("browses remote folders and validates the exact selected path", async () => {
    const workspaceRoots = vi.fn().mockResolvedValue([
      { path: "/Users/codra", label: "Home" },
      { path: "/", label: "Macintosh HD" },
    ]);
    const workspaceList = vi.fn(async (_target, path: string) => ({
      path,
      label: path === "/Users/codra" ? "codra" : "projects",
      breadcrumbs: [
        { path: "/Users/codra", label: "Home" },
        ...(path === "/Users/codra/projects"
          ? [{ path, label: "projects" }]
          : []),
      ],
      entries:
        path === "/Users/codra"
          ? [{ path: "/Users/codra/projects", name: "projects" }]
          : [{ path: "/Users/codra/projects/codra", name: "codra" }],
    }));
    const workspaceValidate = vi.fn().mockResolvedValue({
      path: "/Users/codra/projects",
      label: "projects",
    });
    const onSelect = vi.fn();

    render(
      <RemoteWorkspaceDialog
        open
        target={target}
        currentPath=""
        onClose={vi.fn()}
        onSelect={onSelect}
        workspaceRoots={workspaceRoots}
        workspaceList={workspaceList}
        workspaceValidate={workspaceValidate}
      />,
    );

    expect(
      await screen.findByRole("dialog", {
        name: "Choose workspace on Studio Mac",
      }),
    ).toBeVisible();
    await userEvent.click(await screen.findByRole("button", { name: "Home" }));
    await userEvent.click(
      await screen.findByRole("button", { name: "Open projects" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Use projects" }));

    await waitFor(() =>
      expect(workspaceValidate).toHaveBeenCalledWith(
        target,
        "/Users/codra/projects",
      ),
    );
    expect(onSelect).toHaveBeenCalledWith({
      path: "/Users/codra/projects",
      label: "projects",
    });
  });

  it("keeps the picker open and explains a remote listing failure", async () => {
    render(
      <RemoteWorkspaceDialog
        open
        target={target}
        currentPath="/missing"
        onClose={vi.fn()}
        onSelect={vi.fn()}
        workspaceRoots={vi.fn().mockResolvedValue([])}
        workspaceList={vi.fn().mockRejectedValue(new Error("TARGET_OFFLINE"))}
        workspaceValidate={vi.fn()}
      />,
    );

    expect(
      await screen.findByText("The remote folder could not be opened."),
    ).toBeVisible();
    expect(
      screen.getByRole("dialog", { name: "Choose workspace on Studio Mac" }),
    ).toBeVisible();
  });
});
