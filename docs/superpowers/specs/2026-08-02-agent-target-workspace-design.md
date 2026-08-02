# CODRA Agent Target and Workspace Design

**Date:** 2026-08-02
**Status:** Approved interaction direction; implementation plan pending

## Goal

Keep the first prompt as the dominant action in `New agent`, while making the execution device, workspace, and YOLO mode immediately available without turning them into large configuration sections.

The user can launch an agent on this computer or on an online CODRA desktop registered to the same account. A remote workspace is selected by browsing the remote host's directory tree through the approved encrypted remote session. Directory names, paths, prompts, and terminal data never pass through Firebase.

## Chosen Interaction

The dialog hierarchy is:

1. First prompt
2. One compact launch-control rail
3. Runtime, model, and effort configuration
4. Launch actions

The launch-control rail sits directly below the prompt:

```text
[ This Mac  v ] [ codra  v ]                  YOLO [switch] [?]
  device chip     workspace chip
```

### Device chip

- Defaults to `This Mac`.
- Opens a popover containing `This Mac` followed by online, same-account CODRA desktop hosts.
- Each remote option shows its display name and live status. Offline hosts cannot be newly selected.
- If a selected remote host disconnects, its chip remains visible with an unavailable state and `Start agent` becomes disabled.
- Selecting a remote host requests the minimum remote scopes needed for directory browsing and agent launch. While the remote host is awaiting approval, the workspace chip shows `Waiting for approval` and cannot open the tree.

### Workspace chip

- Displays only the final folder name, matching compact workspace selectors in other agent tools.
- Its accessible label and tooltip contain the complete path and selected device.
- `/` and Windows drive roots retain an unambiguous root label rather than an empty basename.
- Clicking the chip for `This Mac` opens the existing native directory dialog.
- Clicking the chip for a connected remote host opens a CODRA directory-tree dialog.
- The dialog remembers one selected workspace per device for its current lifetime. Switching devices restores that device's last selection rather than copying a local path to a remote host.

### Remote directory-tree dialog

- Starts from a bounded root page supplied by the host: the OS user home directory first, followed by currently mounted filesystem roots that the same OS user can traverse.
- Loads one directory level at a time over the encrypted WebRTC control channel.
- Shows breadcrumbs, folder rows, loading, empty, disconnected, and permission-denied states.
- Returns only a selected directory. It does not read files, preview contents, search the filesystem, or mutate the remote host.
- The confirm action is disabled until the host validates that the selected path still exists and is a directory.

### YOLO control

- The large permission panel is removed.
- `YOLO`, its switch, and a help icon occupy the right edge of the launch-control rail.
- Hovering or focusing the help icon opens an accessible tooltip explaining that YOLO removes the selected CLI's sandbox and confirmation gates.
- Escape and pointer exit dismiss the tooltip. The tooltip is not required to operate the switch.
- For a runtime without YOLO support, the switch is disabled and the tooltip explains why.

### Runtime configuration

- Agent, model, and effort remain below the launch-control rail as secondary configuration.
- Changing runtime does not reset the prompt, device, or workspace.
- Runtime catalogs are target-specific because different computers can have different CLIs, models, and capabilities installed.
- Changing device loads that target's catalog and restores its last valid runtime choice. If the previous choice is unavailable, the first available runtime is selected explicitly and the UI reports the change.
- Install/setup guidance remains conditional and compact.

## Alternatives Considered

### Manual remote path entry

Smallest protocol change, but error-prone and poor for unfamiliar hosts. Rejected because it makes remote setup harder than local setup and cannot validate discoverability before launch.

### Recent remote paths only

Fast after a successful first launch, but provides no first-use discovery. Rejected as the primary interaction; recents can be added later inside the tree dialog.

### Scoped remote directory tree — selected

Adds an explicit read-only protocol surface, but provides consistent local/remote workspace selection and validates paths on the host. This is the chosen approach.

## Architecture

### Renderer contracts

The renderer consumes typed, privileged APIs and never imports Firebase, WebRTC, Node, or filesystem modules.

```ts
type AgentExecutionTarget =
  | { kind: "local" }
  | { kind: "remote"; deviceId: string; displayName: string };

type AgentWorkspace = {
  target: AgentExecutionTarget;
  path: string;
  label: string;
};
```

The launch request contains the execution target, validated workspace path, existing `AgentLaunchRequest`, and terminal dimensions. A local request routes to `TerminalManager`; a remote request routes to the remote client service in Electron main.

### Electron main remote client

Electron main owns same-account host discovery, signed session creation, WebRTC connection state, directory browsing, and remote terminal proxying. It exposes only strict IPC methods for:

- listing launch targets;
- connecting to a selected target;
- loading the selected target's agent runtime catalog;
- listing remote directory roots and child directories;
- validating a remote directory selection;
- launching and attaching to a remote agent terminal;
- routing terminal input, resize, output, and detach.

Remote proxy terminals appear in the existing terminal workspace with their device identity retained. Local and remote terminal IDs are routed by origin so a renderer cannot turn a local operation into a remote one by changing an ID.

### Remote protocol additions

The authenticated control channel adds versioned, correlated operations:

```text
workspace.roots
workspace.list
workspace.validate
agent.runtimes
agent.launch
```

The remote session requests only the corresponding scopes. `agent.runtimes` returns the same strict, path-free runtime metadata used by the local dialog. `agent.launch` accepts the existing strict agent launch fields, the host-validated directory, and terminal dimensions. It never accepts an arbitrary executable, shell command, environment map, or Firebase-backed payload.

The host launches through the same agent runtime resolver and `TerminalManager` used locally. Output and input remain on the existing WebRTC terminal channels.

## Security and Privacy

- Firebase remains signaling and control-plane storage only.
- Directory names, paths, prompts, and terminal bytes travel only through the authenticated WebRTC session.
- The host canonicalizes every requested path and rejects malformed, missing, non-directory, or disallowed targets.
- Directory responses are bounded by entry count, encoded byte size, depth per request, and deadline.
- Only directory metadata needed by the picker is returned. No file contents, sizes, permissions, hidden credentials, environment values, or symlink targets are exposed.
- Session approval, device generation, owner UID, key thumbprints, expiry, and approved scopes are revalidated before browsing and launch.
- A disconnect invalidates pending tree requests and disables launch without falling back to local execution.

## State and Error Handling

- Prompt, per-device workspace choices, and per-device runtime choices survive unrelated configuration changes.
- Changing device cancels stale directory requests from the previous device.
- Reopening the dialog defaults to the active terminal's device and workspace when still available; otherwise it falls back explicitly to `This Mac`.
- Remote approval rejection, timeout, disconnect, missing runtime, invalid path, and launch failure use stable error codes mapped to concise UI messages.
- No remote failure silently launches on the local machine.

## Testing

- Component tests assert prompt-first hierarchy, left-side device/workspace chips, right-side YOLO switch/help tooltip, basename rendering, full-path accessibility, and per-device workspace retention.
- Protocol tests reject unknown fields, oversized directory pages, traversal attempts, arbitrary commands, and operations outside approved scopes.
- Main-process tests verify local routing, remote routing, stale-request cancellation, host-side path validation, runtime resolution, and proxy terminal identity.
- WebRTC integration tests cover remote tree pagination, disconnect during browsing, remote agent launch, terminal attach/input/resize, and proof that no path/prompt/terminal data is written to Firebase.
- Electron E2E verifies the compact layout at 900x720 and native local selection. Remote E2E uses two isolated CODRA device identities and a direct-ICE test session.

## Current Implementation Constraint

The repository currently has the remote session/control schemas and host presence/approval control plane, but the complete host/client WebRTC terminal data plane is not yet present in production source. The implementation must therefore add that transport path; a UI-only remote chip would be misleading and is explicitly out of scope.
