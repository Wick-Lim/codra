import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import type { AgentRuntime } from "@codra/protocol";
import { SettingsDialog } from "./SettingsDialog";

void React;

const profile = {
  displayName: "Jun Hyeog Im",
  email: "jun@example.com",
  photoUrl: null,
};

const gemini: AgentRuntime = {
  kind: "gemini",
  label: "Gemini CLI",
  description: "Google's open-source terminal coding agent.",
  available: false,
  supportsYolo: true,
  modelRequired: false,
  efforts: [],
  models: [{ id: "auto", label: "Auto" }],
  installHint: "Install @google/gemini-cli to use this runtime.",
  setup: { installMethod: "managed_npm", authentication: "required" },
};

describe("SettingsDialog", () => {
  it("controls remote hosting with a switch for a signed-in account", async () => {
    const onRemoteChange = vi.fn();
    render(
      <SettingsDialog
        open
        accountStatus={{ state: "signed_in", profile }}
        remoteStatus={{ state: "idle" }}
        onClose={vi.fn()}
        onRemoteChange={onRemoteChange}
        onSignIn={vi.fn()}
      />,
    );

    const remoteSwitch = screen.getByRole("switch", {
      name: "Remote access",
    });
    expect(remoteSwitch).not.toBeChecked();
    await userEvent.click(remoteSwitch);
    expect(onRemoteChange).toHaveBeenCalledWith(true);
  });

  it("directs signed-out users to sign in without enabling the switch", async () => {
    const onSignIn = vi.fn();
    render(
      <SettingsDialog
        open
        accountStatus={{ state: "signed_out" }}
        remoteStatus={{ state: "idle" }}
        onClose={vi.fn()}
        onRemoteChange={vi.fn()}
        onSignIn={onSignIn}
      />,
    );

    expect(
      screen.getByRole("switch", { name: "Remote access" }),
    ).toBeDisabled();
    expect(screen.getByText(/Sign in.*remote access/i)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(onSignIn).toHaveBeenCalledOnce();
  });

  it("opens directly to agent runtimes and keeps setup out of remote settings", async () => {
    const onAgentSetup = vi.fn();
    render(
      <SettingsDialog
        open
        initialSection="agents"
        runtimes={[gemini]}
        accountStatus={{ state: "signed_out" }}
        remoteStatus={{ state: "idle" }}
        onClose={vi.fn()}
        onRemoteChange={vi.fn()}
        onSignIn={vi.fn()}
        onAgentSetup={onAgentSetup}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Agent runtimes" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("heading", { name: "Agent runtimes" }),
    ).toBeVisible();
    expect(screen.queryByRole("switch", { name: "Remote access" })).toBeNull();
    await userEvent.click(
      screen.getByRole("button", {
        name: "Install and sign in to Gemini CLI",
      }),
    );
    expect(onAgentSetup).toHaveBeenCalledWith({
      kind: "gemini",
      action: "install",
    });
  });
});
