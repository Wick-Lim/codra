import {
  PublicEcJwkSchema,
  createRfc7638Thumbprint,
  type PublicEcJwk,
} from "@codra/protocol";
import { validateAndImportPublicJwk } from "./canonical-crypto";

export interface DeviceIdentity {
  readonly privateKey: CryptoKey;
  readonly publicKey: CryptoKey;
  readonly publicKeyJwk: PublicEcJwk;
  readonly keyThumbprint: string;
}

export async function createDeviceIdentity(): Promise<DeviceIdentity> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  if (!("privateKey" in pair) || !("publicKey" in pair))
    throw new Error("P-256 key generation did not return a key pair");
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const publicKeyJwk = PublicEcJwkSchema.parse({
    kty: exported.kty,
    crv: exported.crv,
    x: exported.x,
    y: exported.y,
  });
  const publicKey = await validateAndImportPublicJwk(publicKeyJwk);
  return {
    privateKey: pair.privateKey,
    publicKey,
    publicKeyJwk,
    keyThumbprint: createRfc7638Thumbprint(publicKeyJwk),
  };
}

export async function importDevicePublicKey(
  publicKeyJwk: PublicEcJwk,
): Promise<CryptoKey> {
  return validateAndImportPublicJwk(PublicEcJwkSchema.parse(publicKeyJwk));
}
