import { z } from "zod";

const base64UrlPattern = /^[A-Za-z0-9_-]+$/;
const hex = (value: string): bigint => BigInt(`0x${value}`);
const P256 = hex(
  "ffffffff00000001000000000000000000000000ffffffffffffffffffffffff",
);
const P256B = hex(
  "5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b",
);

function base64UrlBytes(value: string): Uint8Array {
  if (!base64UrlPattern.test(value) || value.length % 4 === 1) {
    throw new Error("Expected unpadded base64url");
  }
  const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  const decoded = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const result = Uint8Array.from(decoded, (character) =>
    character.charCodeAt(0),
  );
  if (encodeBase64Url(result) !== value)
    throw new Error("Expected canonical unpadded base64url");
  return result;
}

export function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}

function isExactBase64UrlBytes(value: string, length: number): boolean {
  try {
    return base64UrlBytes(value).byteLength === length;
  } catch {
    return false;
  }
}

function sha256(input: Uint8Array): Uint8Array {
  const words = new Uint32Array(64);
  const bitLength = input.byteLength * 8;
  const paddedLength = ((input.byteLength + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.byteLength] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const rotr = (value: number, amount: number): number =>
    (value >>> amount) | (value << (32 - amount));

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous = words[index - 15];
      const prior = words[index - 2];
      const small0 = rotr(previous, 7) ^ rotr(previous, 18) ^ (previous >>> 3);
      const small1 = rotr(prior, 17) ^ rotr(prior, 19) ^ (prior >>> 10);
      words[index] =
        (words[index - 16] + small0 + words[index - 7] + small1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const big1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + big1 + choose + constants[index] + words[index]) >>> 0;
      const big0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (big0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  const output = new Uint8Array(32);
  const result = [h0, h1, h2, h3, h4, h5, h6, h7];
  result.forEach((word, index) => view.setUint32(index * 4, word, false));
  output.set(new Uint8Array(view.buffer, 0, 32));
  return output;
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function isOnP256Curve(xBytes: Uint8Array, yBytes: Uint8Array): boolean {
  const x = BigInt(
    `0x${Array.from(xBytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
  );
  const y = BigInt(
    `0x${Array.from(yBytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
  );
  if (x >= P256 || y >= P256) return false;
  const left = (y * y) % P256;
  const right = (((x * x) % P256) * x + (P256 - 3n) * x + P256B) % P256;
  return left === right;
}

export const PublicEcJwkSchema = z
  .object({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: z.string().regex(base64UrlPattern),
    y: z.string().regex(base64UrlPattern),
  })
  .strict()
  .superRefine((value, context) => {
    let x: Uint8Array;
    let y: Uint8Array;
    try {
      x = base64UrlBytes(value.x);
      y = base64UrlBytes(value.y);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Coordinates must be unpadded base64url",
      });
      return;
    }
    if (x.byteLength !== 32 || y.byteLength !== 32 || !isOnP256Curve(x, y)) {
      context.addIssue({
        code: "custom",
        message: "Coordinates are not a P-256 point",
      });
    }
  });

export type PublicEcJwk = z.infer<typeof PublicEcJwkSchema>;

export const ThumbprintSchema = z
  .string()
  .refine(
    (value) => isExactBase64UrlBytes(value, 32),
    "Expected an unpadded 32-byte SHA-256 thumbprint",
  );

export const P256SignatureSchema = z
  .string()
  .refine(
    (value) => isExactBase64UrlBytes(value, 64),
    "Expected an unpadded 64-byte IEEE-P1363 signature",
  );

export const PkceVerifierSchema = z
  .string()
  .length(43)
  .regex(base64UrlPattern)
  .refine(
    (value) => isExactBase64UrlBytes(value, 32),
    "Expected 32 random bytes",
  );

export const PkceChallengeSchema = z
  .string()
  .refine(
    (value) => isExactBase64UrlBytes(value, 32),
    "Expected an unpadded SHA-256 digest",
  );

export function createPkceVerifier(
  randomBytes: Uint8Array = crypto.getRandomValues(new Uint8Array(32)),
): string {
  if (randomBytes.byteLength !== 32)
    throw new RangeError("PKCE verifier requires 32 random bytes");
  return PkceVerifierSchema.parse(encodeBase64Url(randomBytes));
}

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("Canonical JSON cannot contain non-finite numbers");
    if (Number.isInteger(value) && !Number.isSafeInteger(value))
      throw new TypeError("Canonical JSON cannot contain unsafe integers");
    return JSON.stringify(value);
  }
  if (
    typeof value === "bigint" ||
    typeof value === "undefined" ||
    typeof value === "function"
  ) {
    throw new TypeError("Canonical JSON cannot contain this value");
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  }
  throw new TypeError("Canonical JSON cannot contain this value");
}

export function sha256Base64Url(value: string | Uint8Array): string {
  return encodeBase64Url(
    sha256(typeof value === "string" ? utf8(value) : value),
  );
}

export function createRfc7638Thumbprint(jwk: PublicEcJwk): string {
  const key = PublicEcJwkSchema.parse(jwk);
  return sha256Base64Url(
    canonicalJson({ crv: key.crv, kty: key.kty, x: key.x, y: key.y }),
  );
}

export function createPkceChallenge(verifier: string): string {
  const parsed = PkceVerifierSchema.parse(verifier);
  return sha256Base64Url(parsed);
}

export function canonicalPayloadDigest(payload: unknown): string {
  return sha256Base64Url(canonicalJson(payload));
}

export async function signCanonicalPayload(
  privateKey: CryptoKey | JsonWebKey,
  payload: unknown,
): Promise<string> {
  const key =
    typeof CryptoKey !== "undefined" && privateKey instanceof CryptoKey
      ? privateKey
      : await crypto.subtle.importKey(
          "jwk",
          privateKey as JsonWebKey,
          { name: "ECDSA", namedCurve: "P-256" },
          false,
          ["sign"],
        );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    utf8(canonicalJson(payload)) as unknown as BufferSource,
  );
  return P256SignatureSchema.parse(encodeBase64Url(new Uint8Array(signature)));
}

export async function verifyCanonicalPayload(
  publicKey: PublicEcJwk,
  signature: string,
  payload: unknown,
): Promise<boolean> {
  PublicEcJwkSchema.parse(publicKey);
  P256SignatureSchema.parse(signature);
  const key = await crypto.subtle.importKey(
    "jwk",
    publicKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    base64UrlBytes(signature) as unknown as BufferSource,
    utf8(canonicalJson(payload)) as unknown as BufferSource,
  );
}

export function decodeBase64Url(value: string): Uint8Array {
  return base64UrlBytes(value);
}
