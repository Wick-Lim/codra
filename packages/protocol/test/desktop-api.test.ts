import { describe, expect, it } from "vitest";
import {
  AgentTargetConnectRequestSchema,
  AgentTargetRuntimeRequestSchema,
  AgentSetupResultSchema,
  IPC_CHANNELS,
  RemoteAccountProfileSchema,
  RemoteAccountStateSchema,
  RemoteAccountStatusSchema,
  RemoteAuthProviderSchema,
  RemoteHostStateSchema,
  RemoteHostStatusSchema,
  WorkspaceListRequestSchema,
  WorkspaceTargetRequestSchema,
  WorkspaceValidateRequestSchema,
} from "../src/desktop-api";

const remoteTarget = {
  kind: "remote",
  deviceId: "2d19c478-51e8-4eb8-8aa0-a2c9f2aabec1",
  displayName: "Studio Mac",
} as const;

describe("desktop remote IPC contract", () => {
  it("accepts the bounded remote host states and status payload", () => {
    expect(RemoteHostStateSchema.parse("idle")).toBe("idle");
    expect(RemoteHostStateSchema.parse("activating")).toBe("activating");
    expect(RemoteHostStateSchema.parse("online")).toBe("online");
    expect(RemoteHostStateSchema.parse("error")).toBe("error");
    expect(RemoteHostStatusSchema.parse({ state: "idle" })).toEqual({
      state: "idle",
    });
    expect(
      RemoteHostStatusSchema.parse({ state: "error", message: "LOGIN_FAILED" }),
    ).toEqual({ state: "error", message: "LOGIN_FAILED" });
    expect(() =>
      RemoteHostStatusSchema.parse({ state: "error", secret: "no" }),
    ).toThrow();
  });

  it("keeps account authentication independent from host activation", () => {
    expect(RemoteAuthProviderSchema.parse("google")).toBe("google");
    expect(RemoteAuthProviderSchema.parse("email_password")).toBe(
      "email_password",
    );
    expect(RemoteAccountStateSchema.parse("signed_out")).toBe("signed_out");
    expect(RemoteAccountStateSchema.parse("signing_in")).toBe("signing_in");
    const profile = {
      displayName: "Jun Hyeog Im",
      email: "jun@example.com",
      photoUrl: "https://lh3.googleusercontent.com/a/avatar",
    };
    expect(RemoteAccountProfileSchema.parse(profile)).toEqual(profile);
    expect(
      RemoteAccountStatusSchema.parse({ state: "signed_in", profile }),
    ).toEqual({ state: "signed_in", profile });
    expect(() =>
      RemoteAccountStatusSchema.parse({ state: "signed_in" }),
    ).toThrow();
    expect(
      RemoteAccountStatusSchema.parse({
        state: "error",
        message: "AUTH_PROVIDER_UNAVAILABLE",
      }),
    ).toEqual({ state: "error", message: "AUTH_PROVIDER_UNAVAILABLE" });
  });

  it("freezes remote action and event channel names", () => {
    expect(IPC_CHANNELS.agentList).toBe("codra:agent:list");
    expect(IPC_CHANNELS.agentSetup).toBe("codra:agent:setup");
    expect(IPC_CHANNELS.remoteGetState).toBe("codra:remote:get-state");
    expect(IPC_CHANNELS.remoteLogin).toBe("codra:remote:login");
    expect(IPC_CHANNELS.remoteState).toBe("codra:remote:state");
    expect(IPC_CHANNELS.remoteGetAuthState).toBe("codra:remote:get-auth-state");
    expect(IPC_CHANNELS.remoteAuthState).toBe("codra:remote:auth-state");
    expect(IPC_CHANNELS.remoteActivate).toBe("codra:remote:activate");
    expect(IPC_CHANNELS.remoteDeactivate).toBe("codra:remote:deactivate");
    expect(IPC_CHANNELS.remoteLogout).toBe("codra:remote:logout");
  });

  it("accepts only bounded agent setup results", () => {
    const terminal = {
      id: "f4b0f73d-3406-48ec-a5c2-2cf290905e99",
      title: "Setup Gemini",
      cwd: "/workspace",
      cols: 100,
      rows: 30,
      state: "running" as const,
      createdAt: "2026-08-02T00:00:00.000Z",
    };

    expect(
      AgentSetupResultSchema.parse({ kind: "terminal", terminal }),
    ).toEqual({ kind: "terminal", terminal });
    expect(AgentSetupResultSchema.parse({ kind: "external" })).toEqual({
      kind: "external",
    });
    expect(() =>
      AgentSetupResultSchema.parse({
        kind: "external",
        url: "https://attacker.example/install",
      }),
    ).toThrow();
  });

  it("validates target runtime and workspace requests before privileged IPC", () => {
    expect(
      AgentTargetConnectRequestSchema.parse({ target: remoteTarget }),
    ).toEqual({ target: remoteTarget });
    expect(
      AgentTargetRuntimeRequestSchema.parse({ target: { kind: "local" } }),
    ).toEqual({ target: { kind: "local" } });
    expect(
      WorkspaceTargetRequestSchema.parse({ target: remoteTarget }),
    ).toEqual({ target: remoteTarget });
    expect(
      WorkspaceListRequestSchema.parse({
        target: remoteTarget,
        path: "/Users/codra",
      }),
    ).toEqual({ target: remoteTarget, path: "/Users/codra" });
    expect(
      WorkspaceValidateRequestSchema.parse({
        target: remoteTarget,
        path: "/Users/codra/project",
      }),
    ).toEqual({ target: remoteTarget, path: "/Users/codra/project" });
    expect(() =>
      WorkspaceListRequestSchema.parse({
        target: remoteTarget,
        path: "/Users/codra",
        includeFiles: true,
      }),
    ).toThrow();
  });

  it("names every target and workspace IPC boundary explicitly", () => {
    expect(IPC_CHANNELS.agentTargets).toBe("codra:agent:targets");
    expect(IPC_CHANNELS.agentConnectTarget).toBe("codra:agent:connect-target");
    expect(IPC_CHANNELS.agentTargetRuntimes).toBe(
      "codra:agent:target-runtimes",
    );
    expect(IPC_CHANNELS.agentWorkspaceRoots).toBe(
      "codra:agent:workspace-roots",
    );
    expect(IPC_CHANNELS.agentWorkspaceList).toBe("codra:agent:workspace-list");
    expect(IPC_CHANNELS.agentWorkspaceValidate).toBe(
      "codra:agent:workspace-validate",
    );
    expect(IPC_CHANNELS.agentTargetsChanged).toBe(
      "codra:agent:targets-changed",
    );
  });
});
