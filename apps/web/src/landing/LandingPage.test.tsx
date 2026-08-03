// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import LandingPage from "./LandingPage";

// Vitest globals are off for this workspace, so Testing Library's automatic
// cleanup never registers itself. Unmount between cases explicitly, otherwise
// the "exactly one primary control" assertion below counts stale renders.
afterEach(cleanup);

function text(element: HTMLElement): string {
  return (element.textContent ?? "").trim();
}

describe("LandingPage", () => {
  it("renders one page heading", () => {
    render(<LandingPage onOpenConsole={vi.fn()} />);

    // Selected by role, not by wording: Task 4 translates this page.
    expect(text(screen.getByRole("heading", { level: 1 }))).not.toBe("");
  });

  it("states that local use needs no account", () => {
    render(<LandingPage onOpenConsole={vi.fn()} />);

    expect(text(screen.getByTestId("landing-local-claim"))).not.toBe("");
  });

  it("states that terminal data never reaches the server", () => {
    render(<LandingPage onOpenConsole={vi.fn()} />);

    expect(text(screen.getByTestId("landing-privacy-claim"))).not.toBe("");
  });

  it("exposes exactly one primary control, which opens the console", async () => {
    const onOpenConsole = vi.fn();
    render(<LandingPage onOpenConsole={onOpenConsole} />);

    expect(screen.getAllByTestId("landing-open-console")).toHaveLength(1);
    expect(screen.getAllByRole("button")).toHaveLength(1);

    const openConsole = screen.getByTestId("landing-open-console");
    expect(text(openConsole)).not.toBe("");
    expect(onOpenConsole).not.toHaveBeenCalled();

    await userEvent.click(openConsole);

    expect(onOpenConsole).toHaveBeenCalledTimes(1);
  });
});
