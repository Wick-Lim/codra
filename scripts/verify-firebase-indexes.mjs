import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const config = JSON.parse(await readFile("firestore.indexes.json", "utf8"));
assert.deepEqual(config.fieldOverrides, []);
assert.equal(config.indexes.length, 5);
const expected = [
  [
    "devices",
    [
      "kind:ASCENDING",
      "active:ASCENDING",
      "remoteAccessEnabled:ASCENDING",
      "expiresAt:ASCENDING",
    ],
  ],
  [
    "remoteSessions",
    [
      "hostDeviceId:ASCENDING",
      "hostKeyThumbprint:ASCENDING",
      "hostDeviceGeneration:ASCENDING",
      "status:ASCENDING",
      "createdAt:ASCENDING",
    ],
  ],
  [
    "remoteSessions",
    [
      "clientDeviceId:ASCENDING",
      "clientKeyThumbprint:ASCENDING",
      "clientDeviceGeneration:ASCENDING",
      "createdAt:DESCENDING",
    ],
  ],
  [
    "signals",
    [
      "senderDeviceId:ASCENDING",
      "recipientDeviceId:ASCENDING",
      "negotiationId:ASCENDING",
      "sequence:ASCENDING",
    ],
  ],
  [
    "signals",
    [
      "recipientDeviceId:ASCENDING",
      "senderDeviceId:ASCENDING",
      "negotiationId:ASCENDING",
      "sequence:ASCENDING",
    ],
  ],
];
for (const [index, indexConfig] of config.indexes.entries()) {
  const [collectionGroup, fields] = expected[index];
  assert.equal(indexConfig.queryScope, "COLLECTION");
  assert.equal(indexConfig.collectionGroup, collectionGroup);
  assert.deepEqual(
    indexConfig.fields.map((field) => `${field.fieldPath}:${field.order}`),
    fields,
  );
}
