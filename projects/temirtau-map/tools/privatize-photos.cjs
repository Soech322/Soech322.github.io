const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getStorage } = require('firebase-admin/storage');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// Run outside Hosting; requires operator-supplied Application Default Credentials.
// Defaults to dry-run; --apply explicitly performs the migration.
const args = process.argv.slice(2);
const arg = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const projectId = arg('--project'), storageBucket = arg('--bucket');
if (!projectId || !storageBucket) {
  console.error('Usage: node privatize-photos.cjs --project PROJECT_ID --bucket BUCKET [--apply]');
  process.exit(1);
}
const apply = args.includes('--apply');
initializeApp({ credential: applicationDefault(), projectId, storageBucket });

function privatePath(value) {
  if (/^(registry-photos|card-photos)\//.test(value)) return value;
  if (value.startsWith('gs://' + storageBucket + '/')) return value.slice(('gs://' + storageBucket + '/').length);
  const url = new URL(value);
  if (url.hostname !== 'firebasestorage.googleapis.com') throw new Error('Unexpected photo host');
  const match = url.pathname.match(/^\/v0\/b\/([^/]+)\/o\/(.+)$/);
  if (!match || decodeURIComponent(match[1]) !== storageBucket) throw new Error('Unexpected photo bucket');
  const path = decodeURIComponent(match[2]);
  if (!/^(registry-photos|card-photos)\//.test(path)) throw new Error('Unexpected photo prefix');
  return path;
}

(async () => {
  const bucket = getStorage().bucket();
  const db = getFirestore();
  const updates = [];
  // Validate all document references before mutating anything.
  for (const collection of ['gis_control_overrides', 'repair_works_overrides']) {
    const snapshot = await db.collection(collection).get();
    for (const doc of snapshot.docs) {
      const change = {};
      for (const field of ['photo1Url', 'photo2Url']) {
        const value = doc.get(field);
        if (!value) continue;
        const path = privatePath(value);
        if (path !== value) change[field] = path;
      }
      if (Object.keys(change).length) updates.push({ doc, change });
    }
  }
  let files = 0;
  for (const prefix of ['registry-photos/', 'card-photos/']) {
    // getFiles auto-paginates; legacy/orphan files also need their old bearer tokens revoked.
    const [items] = await bucket.getFiles({ prefix });
    for (const file of items) {
      files++;
      if (apply) {
        await file.setMetadata({ cacheControl: 'private, no-store', metadata: { firebaseStorageDownloadTokens: null } });
        const [metadata] = await file.getMetadata();
        if (metadata.metadata?.firebaseStorageDownloadTokens) throw new Error('Token revocation failed: ' + file.name);
      }
    }
  }
  if (apply) {
    for (const { doc, change } of updates) {
      // Retry-safe; fail on concurrent changes instead of overwriting a newer upload.
      await db.runTransaction(async transaction => {
        const latest = await transaction.get(doc.ref);
        const safe = {};
        for (const [field, value] of Object.entries(change)) {
          if (latest.get(field) === doc.get(field)) safe[field] = value;
        }
        if (!Object.keys(safe).length) return;
        transaction.update(doc.ref, safe);
        transaction.create(db.collection('audit_log').doc(), {
          section: doc.ref.parent.id === 'gis_control_overrides' ? 'gis' : 'repair',
          featureId: doc.id, action: 'photo-privacy-migration', before: {},
          after: safe, by: 'photo-privacy-migration',
          at: FieldValue.serverTimestamp(), atIso: new Date().toISOString()
        });
      });
    }
  }
  console.log(JSON.stringify({ mode: apply ? 'APPLIED' : 'DRY RUN', files, documents: updates.length }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
