import {
  P256SignatureSchema,
  PublicEcJwkSchema,
  canonicalJson,
  createRfc7638Thumbprint,
  decodeBase64Url,
  encodeBase64Url,
  sha256Base64Url,
  type PublicEcJwk,
} from "@codra/protocol";

export type SignerKey = CryptoKey;
export type VerifierKey = CryptoKey;

export async function validateAndImportPublicJwk(
  jwk: PublicEcJwk,
): Promise<VerifierKey> {
  const parsed = PublicEcJwkSchema.parse(jwk);
  return crypto.subtle.importKey(
    "jwk",
    parsed,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

export function computeRfc7638Thumbprint(jwk: PublicEcJwk): string {
  return createRfc7638Thumbprint(PublicEcJwkSchema.parse(jwk));
}

export async function signCanonical(
  privateKey: SignerKey,
  payload: unknown,
): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(canonicalJson(payload)) as unknown as BufferSource,
  );
  return P256SignatureSchema.parse(encodeBase64Url(new Uint8Array(signature)));
}

export async function verifyCanonical(
  publicKey: VerifierKey,
  signature: string,
  payload: unknown,
): Promise<boolean> {
  P256SignatureSchema.parse(signature);
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    decodeBase64Url(signature) as unknown as BufferSource,
    new TextEncoder().encode(canonicalJson(payload)) as unknown as BufferSource,
  );
}

export function canonicalDigest(payload: unknown): string {
  return sha256Base64Url(canonicalJson(payload));
}
