import type { CodraDesktopApi } from "@codra/protocol";

declare global {
  interface Window {
    codra: CodraDesktopApi;
  }
}

export {};
