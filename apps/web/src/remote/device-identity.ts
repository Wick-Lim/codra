import {
  createDeviceIdentity,
  importDevicePublicKey,
  type DeviceIdentity,
} from "@codra/webrtc";
import {
  PublicEcJwkSchema,
  ThumbprintSchema,
  type PublicEcJwk,
} from "@codra/protocol";

const DATABASE_NAME = "codra-remote";
const DATABASE_VERSION = 1;
const STORE_NAME = "device-identity";
const RECORD_KEY = "browser";

interface StoredBrowserIdentity {
  deviceId: string;
  ownerUid?: string;
  privateKey: CryptoKey;
  publicKeyJwk: PublicEcJwk;
  keyThumbprint: string;
}

export interface BrowserDeviceIdentity extends DeviceIdentity {
  readonly deviceId: string;
  readonly ownerUid?: string;
  readonly created: boolean;
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined")
    return Promise.reject(new Error("BROWSER_IDENTITY_STORAGE_REQUIRED"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () =>
      reject(request.error ?? new Error("IDB_OPEN_FAILED"));
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME))
        request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function readStoredIdentity(): Promise<
  StoredBrowserIdentity | undefined
> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(RECORD_KEY);
    request.onerror = () =>
      reject(request.error ?? new Error("IDB_READ_FAILED"));
    request.onsuccess = () => {
      database.close();
      resolve(request.result as StoredBrowserIdentity | undefined);
    };
  });
}

async function writeStoredIdentity(
  value: StoredBrowserIdentity,
): Promise<void> {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    const request = transaction.objectStore(STORE_NAME).put(value, RECORD_KEY);
    request.onerror = () =>
      reject(request.error ?? new Error("IDB_WRITE_FAILED"));
    transaction.oncomplete = () => {
      database.close();
      resolve();
    };
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IDB_WRITE_FAILED"));
  });
}

function deviceId(): string {
  if (!crypto.randomUUID) throw new Error("BROWSER_CRYPTO_UUID_REQUIRED");
  return crypto.randomUUID();
}

export async function loadOrCreateBrowserDeviceIdentity(): Promise<BrowserDeviceIdentity> {
  const stored = await readStoredIdentity();
  if (stored) {
    const publicKeyJwk = PublicEcJwkSchema.parse(stored.publicKeyJwk);
    const keyThumbprint = ThumbprintSchema.parse(stored.keyThumbprint);
    const publicKey = await importDevicePublicKey(publicKeyJwk);
    return {
      deviceId: stored.deviceId,
      ownerUid: stored.ownerUid,
      privateKey: stored.privateKey,
      publicKey,
      publicKeyJwk,
      keyThumbprint,
      created: false,
    };
  }
  const identity = await createDeviceIdentity();
  const value: StoredBrowserIdentity = {
    deviceId: deviceId(),
    privateKey: identity.privateKey,
    publicKeyJwk: identity.publicKeyJwk,
    keyThumbprint: identity.keyThumbprint,
  };
  await writeStoredIdentity(value);
  return { ...identity, deviceId: value.deviceId, created: true };
}

export async function bindBrowserDeviceOwner(
  identity: BrowserDeviceIdentity,
  ownerUid: string,
): Promise<BrowserDeviceIdentity> {
  if (identity.ownerUid && identity.ownerUid !== ownerUid)
    throw new Error("BROWSER_DEVICE_ACCOUNT_MISMATCH");
  if (identity.ownerUid === ownerUid) return identity;
  await writeStoredIdentity({
    deviceId: identity.deviceId,
    ownerUid,
    privateKey: identity.privateKey,
    publicKeyJwk: identity.publicKeyJwk,
    keyThumbprint: identity.keyThumbprint,
  });
  return { ...identity, ownerUid };
}
