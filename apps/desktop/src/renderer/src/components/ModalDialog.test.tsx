import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { ModalDialog } from "./ModalDialog";

void React;

describe("ModalDialog", () => {
  it("renders outside the workspace and closes on Escape", async () => {
    const onClose = vi.fn();
    render(
      <div data-testid="workspace">
        <ModalDialog open title="Sign in to CODRA" onClose={onClose}>
          <button type="button">Continue</button>
        </ModalDialog>
      </div>,
    );

    const dialog = screen.getByRole("dialog", { name: "Sign in to CODRA" });
    expect(dialog.closest('[data-testid="workspace"]')).toBeNull();
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });
});
