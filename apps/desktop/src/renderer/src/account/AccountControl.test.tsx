import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { AccountControl } from "./AccountControl";
import { SignInDialog } from "./SignInDialog";

void React;

const signedIn = {
  state: "signed_in" as const,
  profile: {
    displayName: "Jun Hyeog Im",
    email: "jun@example.com",
    photoUrl: "https://lh3.googleusercontent.com/a/avatar",
  },
};

describe("AccountControl", () => {
  it("shows the Firebase profile and account actions after sign-in", async () => {
    const onOpenSettings = vi.fn();
    const onLogout = vi.fn();
    render(
      <AccountControl
        accountStatus={signedIn}
        onSignIn={vi.fn()}
        onOpenSettings={onOpenSettings}
        onLogout={onLogout}
      />,
    );

    expect(screen.getByText("Jun Hyeog Im")).toBeVisible();
    expect(screen.getByText("jun@example.com")).toBeVisible();
    expect(screen.getByRole("img", { name: "Jun Hyeog Im" })).toHaveAttribute(
      "src",
      signedIn.profile.photoUrl,
    );

    await userEvent.click(
      screen.getByRole("button", {
        name: "Open account menu for Jun Hyeog Im",
      }),
    );
    expect(screen.getByRole("menu", { name: "Account" })).toBeVisible();
    await userEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();

    await userEvent.click(
      screen.getByRole("button", {
        name: "Open account menu for Jun Hyeog Im",
      }),
    );
    await userEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(onLogout).toHaveBeenCalledOnce();
  });

  it("uses a clear sign-in action before an account exists", async () => {
    const onSignIn = vi.fn();
    render(
      <AccountControl
        accountStatus={{ state: "signed_out" }}
        onSignIn={onSignIn}
        onOpenSettings={vi.fn()}
        onLogout={vi.fn()}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Sign in to CODRA" }),
    );
    expect(onSignIn).toHaveBeenCalledOnce();
  });

  it("falls back to initials when the profile image cannot load", () => {
    render(
      <AccountControl
        accountStatus={signedIn}
        onSignIn={vi.fn()}
        onOpenSettings={vi.fn()}
        onLogout={vi.fn()}
      />,
    );

    fireEvent.error(screen.getByRole("img", { name: "Jun Hyeog Im" }));
    expect(screen.queryByRole("img", { name: "Jun Hyeog Im" })).toBeNull();
    expect(screen.getByText("JI")).toBeVisible();
  });
});

describe("SignInDialog", () => {
  it("presents providers in a real modal and keeps test auth unavailable", async () => {
    const onProvider = vi.fn();
    render(
      <SignInDialog
        open
        busy={false}
        onClose={vi.fn()}
        onProvider={onProvider}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "Sign in to CODRA" }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /Google/ }));
    expect(onProvider).toHaveBeenCalledWith("google");
    expect(
      screen.getByRole("button", { name: /Email.*password/i }),
    ).toBeDisabled();
  });
});
