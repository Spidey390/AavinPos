import { fingerprint } from './financial.js';
export async function collectSnapshot({ projectId, readTime, request, maximumBytes = 64 * 1024 * 1024 }) {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) || !Number.isFinite(Date.parse(readTime))) throw new Error('Invalid backup project or read time.');
  const root = `projects/${projectId}/databases/(default)/documents`, queue = [root], seen = new Set(), documents = [];
  const encodePath = path => path.split('/').map(encodeURIComponent).join('/');
  let bytes = 0;
  for (let index = 0; index < queue.length; index++) {
    const parent = queue[index]; let collectionPage;
    do {
      const groups = await request(`${encodePath(parent)}:listCollectionIds`, 'POST', { pageSize: 250, ...(collectionPage ? { pageToken: collectionPage } : {}), readTime });
      for (const collectionId of groups.collectionIds ?? []) {
        if (typeof collectionId !== 'string' || !collectionId || collectionId.includes('/')) throw new Error('Invalid backup collection path.');
        let documentPage;
        do {
          const params = new URLSearchParams({ pageSize: '250', showMissing: 'true', readTime, ...(documentPage ? { pageToken: documentPage } : {}) });
          const page = await request(`${encodePath(parent)}/${encodeURIComponent(collectionId)}?${params}`, 'GET');
          for (const document of page.documents ?? []) {
            const prefix = `${parent}/${collectionId}/`;
            if (typeof document.name !== 'string' || !document.name.startsWith(prefix) || !document.name.slice(prefix.length) || document.name.slice(prefix.length).includes('/') || seen.has(document.name)) throw new Error('Invalid or repeated backup document.');
            seen.add(document.name); queue.push(document.name);
            if (queue.length > 100000) throw new Error('Backup exceeds the local document limit.');
            if (document.updateTime) {
              bytes += Buffer.byteLength(JSON.stringify(document));
              if (bytes > maximumBytes) throw new Error('Backup exceeds the local snapshot limit.');
              documents.push(document);
            }
          }
          documentPage = page.nextPageToken;
        } while (documentPage);
      }
      collectionPage = groups.nextPageToken;
    } while (collectionPage);
  }
  documents.sort((a,b) => a.name.localeCompare(b.name));
  const body = { format: 'firestore-rest-snapshot-v1', projectId, database: '(default)', readTime, documents };
  return { ...body, digest: fingerprint(body) };
}
export function verifySnapshot(snapshot, projectId) {
  const { digest, ...body } = snapshot, prefix = `projects/${projectId}/databases/(default)/documents/`;
  if (snapshot.format !== 'firestore-rest-snapshot-v1' || snapshot.projectId !== projectId || snapshot.database !== '(default)' || !Array.isArray(snapshot.documents) || fingerprint(body) !== digest || snapshot.documents.some(doc => !doc.name?.startsWith(prefix) || !doc.updateTime) || new Set(snapshot.documents.map(doc=>doc.name)).size !== snapshot.documents.length) throw new Error('Backup digest, project or document validation failed.');
  return { documents: snapshot.documents.length, readTime: snapshot.readTime };
}
