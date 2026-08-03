import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import type { PendingRemoteSession } from "@codra/protocol";
import { SessionApprovalDialog } from "./SessionApprovalDialog";

void React;

const session: PendingRemoteSession = {
  sessionId: "3f0f8f1a-1f7e-4c4a-9a2f-1a2b3c4d5e6f",
  clientDeviceId: "40c77568-ae29-4af2-a57e-453ffc248a7b",
  requesterDisplayName: "Studio Mac",
  requestedScopes: ["workspace.read", "agent.launch"],
  expiresAt: 1_800_000_000_000,
};

describe("SessionApprovalDialog", () => {
  it("names the requester, focuses Deny, and grants every requested scope", async () => {
    const onApprove = vi.fn();

    render(
      <SessionApprovalDialog
        session={session}
        busy={false}
        onApprove={onApprove}
        onDeny={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("dialog", { name: "Allow Studio Mac to connect?" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Deny" })).toHaveFocus();
    expect(
      screen.getByRole("switch", { name: "Grant workspace.read" }),
    ).toBeChecked();
    expect(
      screen.getByRole("switch", { name: "Grant agent.launch" }),
    ).toBeChecked();
    expect(
      screen.getByText(
        "Granting agent.launch lets this device run an agent on this Mac, " +
          "possibly with its own tool approvals disabled.",
      ),
    ).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(onApprove).toHaveBeenCalledWith(["workspace.read", "agent.launch"]);
  });

  it("approves only the scopes left granted", async () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();

    render(
      <SessionApprovalDialog
        session={session}
        busy={false}
        onApprove={onApprove}
        onDeny={onDeny}
      />,
    );

    await userEvent.click(
      screen.getByRole("switch", { name: "Grant agent.launch" }),
    );
    expect(
      screen.getByRole("switch", { name: "Grant agent.launch" }),
    ).not.toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(onApprove).toHaveBeenCalledWith(["workspace.read"]);
    expect(onDeny).not.toHaveBeenCalled();
  });

  it("denies rather than approving an empty scope set", async () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();

    render(
      <SessionApprovalDialog
        session={session}
        busy={false}
        onApprove={onApprove}
        onDeny={onDeny}
      />,
    );

    await userEvent.click(
      screen.getByRole("switch", { name: "Grant workspace.read" }),
    );
    await userEvent.click(
      screen.getByRole("switch", { name: "Grant agent.launch" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(onApprove).not.toHaveBeenCalled();
    expect(onDeny).toHaveBeenCalledOnce();
  });

  it("falls back to the truncated device id and locks the controls while busy", () => {
    render(
      <SessionApprovalDialog
        session={{ ...session, requesterDisplayName: undefined }}
        busy
        error="The remote connection could not be approved."
        onApprove={vi.fn()}
        onDeny={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("dialog", {
        name: "Allow Device 40c77568… to connect?",
      }),
    ).toBeVisible();
    expect(
      screen.getByText("The remote connection could not be approved."),
    ).toBeVisible();
    expect(
      screen.getByRole("switch", { name: "Grant agent.launch" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
  });
});
