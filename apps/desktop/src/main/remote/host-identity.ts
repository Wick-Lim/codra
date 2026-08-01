import { generateKeyPairSync, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { safeStorage } from "electron";
import {
  createRfc7638Thumbprint,
  PublicEcJwkSchema,
  type PublicEcJwk,
} from "@codra/protocol";

interface StoredHostIdentity {
  deviceId: string;
  publicKeyJwk: PublicEcJwk;
  encryptedPrivateJwk: string;
}

export interface HostIdentity {
  deviceId: string;
  publicKeyJwk: PublicEcJwk;
  privateKey: JsonWebKey;
  keyThumbprint: string;
  created: boolean;
}

function privateKeyFromStored(value: string): JsonWebKey {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error("ELECTRON_SAFE_STORAGE_UNAVAILABLE");
  return JSON.parse(
    safeStorage.decryptString(Buffer.from(value, "base64")),
  ) as JsonWebKey;
}

export async function loadOrCreateHostIdentity(
  userDataPath: string,
): Promise<HostIdentity> {
  const directory = join(userDataPath, "remote");
  const file = join(directory, "host-identity.json");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  let stored: StoredHostIdentity | undefined;
  try {
    stored = JSON.parse(await readFile(file, "utf8")) as StoredHostIdentity;
    PublicEcJwkSchema.parse(stored.publicKeyJwk);
    const privateKey = privateKeyFromStored(stored.encryptedPrivateJwk);
    return {
      deviceId: stored.deviceId,
      publicKeyJwk: stored.publicKeyJwk,
      privateKey,
      keyThumbprint: createRfc7638Thumbprint(stored.publicKeyJwk),
      created: false,
    };
  } catch {
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const exportedPublicKey = pair.publicKey.export({ format: "jwk" });
    const publicKeyJwk = PublicEcJwkSchema.parse({
      kty: exportedPublicKey.kty,
      crv: exportedPublicKey.crv,
      x: exportedPublicKey.x,
      y: exportedPublicKey.y,
    });
    const privateJwk = pair.privateKey.export({ format: "jwk" });
    if (!safeStorage.isEncryptionAvailable())
      throw new Error("ELECTRON_SAFE_STORAGE_UNAVAILABLE");
    const encryptedPrivateJwk = safeStorage
      .encryptString(JSON.stringify(privateJwk))
      .toString("base64");
    stored = {
      deviceId: randomUUID(),
      publicKeyJwk,
      encryptedPrivateJwk,
    };
    await writeFile(file, `${JSON.stringify(stored)}\n`, {
      mode: 0o600,
    });
    await chmod(file, 0o600);
  }
  return {
    deviceId: stored.deviceId,
    publicKeyJwk: stored.publicKeyJwk,
    privateKey: JSON.parse(
      safeStorage.decryptString(
        Buffer.from(stored.encryptedPrivateJwk, "base64"),
      ),
    ) as JsonWebKey,
    keyThumbprint: createRfc7638Thumbprint(stored.publicKeyJwk),
    created: true,
  };
}
