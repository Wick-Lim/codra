import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "./SettingsDialog";

void React;

const profile = {
  displayName: "Jun Hyeog Im",
  email: "jun@example.com",
  photoUrl: null,
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
});
