import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

const blocked = reason => ({ kind: 'blocked', reason });
const MAX_BYTES = 1024 * 1024;
const oid = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);

// Checks bytes only. The caller must bind the OID to the correct tree and
// separately validate the content and provenance of that tree.
export function decodeCheckpointGitBlob(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return blocked('invalid-blob');
  const { expectedOid, blob } = input;
  if (!oid(expectedOid) || !blob || typeof blob !== 'object' || Array.isArray(blob)
      || blob.sha !== expectedOid || blob.encoding !== 'base64'
      || !Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size > MAX_BYTES
      || typeof blob.content !== 'string' || blob.content.length > 2 * (MAX_BYTES + 10)) return blocked('invalid-blob');
  const base64 = blob.content.replace(/\n/g, '');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) return blocked('invalid-base64');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length !== blob.size || bytes.toString('base64') !== base64) return blocked('invalid-blob-size-or-encoding');
  const actual = createHash('sha1').update(`blob ${bytes.length}\0`, 'utf8').update(bytes).digest('hex');
  if (actual !== expectedOid) return blocked('blob-hash-mismatch');
  try { return { kind: 'decoded-blob', content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) }; }
  catch { return blocked('invalid-utf8'); }
}
