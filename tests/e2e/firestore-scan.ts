import type { RemoteEmulators } from "./remote-harness";

/**
 * Reads every document the Firestore emulator holds, so a spec can prove that
 * a value which travelled over the data channel was never written to the
 * control plane.
 *
 * Extracted from `remote-agent-workspace.spec.ts`, where it started, so the
 * browser console spec enforces the same privacy claim with the same code
 * rather than a second copy that could drift. Importing it from that spec
 * directly is not an option: Playwright attributes a `test()` call to the file
 * that imports it, so `web-console.spec.ts` would have run the agent-workspace
 * test as well.
 */
export interface ScannedDocument {
  name: string;
  haystack: string;
}

async function firestoreJson(
  url: string,
  init?: { method: string; body: string },
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: "Bearer owner",
      "content-type": "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Firestore emulator returned ${response.status} for ${url}: ${await response.text()}`,
    );
  }
  return (await response.json()) as Record<string, unknown>;
}

async function listCollectionIds(
  origin: string,
  parent: string,
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const body = await firestoreJson(
      `${origin}/v1/${parent}:listCollectionIds`,
      {
        method: "POST",
        body: JSON.stringify({
          pageSize: 300,
          ...(pageToken ? { pageToken } : {}),
        }),
      },
    );
    ids.push(...((body.collectionIds as string[] | undefined) ?? []));
    pageToken = body.nextPageToken as string | undefined;
  } while (pageToken);
  return ids;
}

async function listDocuments(
  origin: string,
  parent: string,
  collectionId: string,
): Promise<Array<Record<string, unknown>>> {
  const documents: Array<Record<string, unknown>> = [];
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams({
      pageSize: "300",
      showMissing: "true",
    });
    if (pageToken) query.set("pageToken", pageToken);
    const body = await firestoreJson(
      `${origin}/v1/${parent}/${collectionId}?${query.toString()}`,
    );
    documents.push(
      ...((body.documents as Array<Record<string, unknown>> | undefined) ?? []),
    );
    pageToken = body.nextPageToken as string | undefined;
  } while (pageToken);
  return documents;
}

function decodedBytes(body: string): string {
  return [...body.matchAll(/"bytesValue":"([A-Za-z0-9+/=]*)"/gu)]
    .map((match) => Buffer.from(match[1]!, "base64").toString("utf8"))
    .join("\n");
}

export async function scanEveryFirestoreDocument(
  emulators: RemoteEmulators,
): Promise<ScannedDocument[]> {
  const origin = emulators.firestoreOrigin;
  const scanned: ScannedDocument[] = [];
  const queue = [
    `projects/${emulators.projectId}/databases/(default)/documents`,
  ];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const collectionId of await listCollectionIds(origin, parent)) {
      for (const document of await listDocuments(
        origin,
        parent,
        collectionId,
      )) {
        const name = String(document.name ?? "");
        const body = JSON.stringify(document);
        scanned.push({
          name,
          haystack: `${name}\n${body}\n${decodedBytes(body)}`,
        });
        queue.push(name);
      }
    }
  }
  return scanned;
}
