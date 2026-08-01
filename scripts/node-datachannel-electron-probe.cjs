/* eslint-disable @typescript-eslint/no-require-imports, no-undef */

const { app } = require("electron");
const { createRequire } = require("node:module");
const { resolve } = require("node:path");

const requireDesktop = createRequire(resolve(process.cwd(), "package.json"));

async function main() {
  await app.whenReady();
  const datachannel = requireDesktop("node-datachannel");
  if (
    typeof datachannel.PeerConnection !== "function" ||
    typeof datachannel.cleanup !== "function" ||
    typeof datachannel.preload !== "function"
  ) {
    throw new Error("node-datachannel Electron API is incomplete");
  }
  datachannel.preload();
  const peer = new datachannel.PeerConnection("codra-native-probe", {
    iceServers: [],
  });
  if (typeof peer.close !== "function") {
    throw new Error("PeerConnection.close is not callable in Electron");
  }
  peer.close();
  datachannel.cleanup();
  await app.quit();
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
