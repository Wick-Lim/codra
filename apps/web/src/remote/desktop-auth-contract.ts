import {
  DesktopLoginAuthorizeRequestSchema,
  PkceVerifierSchema,
} from "@codra/protocol";

export interface DesktopAuthQuery {
  attempt: string;
  state: string;
}

export function parseDesktopAuthQuery(
  search: string,
): DesktopAuthQuery | undefined {
  const query = new URLSearchParams(search);
  const keys = [...query.keys()];
  if (
    keys.length !== 2 ||
    keys.some((key) => key !== "attempt" && key !== "state") ||
    query.getAll("attempt").length !== 1 ||
    query.getAll("state").length !== 1
  ) {
    return undefined;
  }
  const attempt = query.get("attempt");
  const state = query.get("state");
  if (
    typeof attempt !== "string" ||
    typeof state !== "string" ||
    !DesktopLoginAuthorizeRequestSchema.safeParse({
      action: "inspect",
      attemptId: attempt,
      state,
    }).success
  ) {
    return undefined;
  }
  return { attempt, state };
}

export function createDesktopCallbackNavigation(
  callbackUrl: string,
  query: DesktopAuthQuery & { code: string },
): string {
  const callback = new URL(callbackUrl);
  if (
    callback.protocol !== "http:" ||
    callback.hostname !== "127.0.0.1" ||
    callback.username !== "" ||
    callback.password !== "" ||
    callback.pathname !== "/auth/callback" ||
    !callback.port ||
    callback.search ||
    callback.hash ||
    !PkceVerifierSchema.safeParse(query.code).success
  ) {
    throw new Error("DESKTOP_AUTH_CALLBACK_INVALID");
  }
  callback.searchParams.set("attempt", query.attempt);
  callback.searchParams.set("code", query.code);
  callback.searchParams.set("state", query.state);
  return callback.toString();
}
