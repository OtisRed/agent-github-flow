import { isFlowMarker } from './flow-recovery.mjs';

const START = '<!-- agent-github-flow:state\n';
const END = '\nagent-github-flow:state -->';
const TAG = 'agent-github-flow:state';
const blocked = reason => ({ kind: 'blocked', reason });

function encode(marker) {
  if (!isFlowMarker(marker)) return null;
  const { version, phase, commentId, digest, fromStatus, targetStatus } = marker;
  return JSON.stringify({ version, phase, commentId, digest, fromStatus, targetStatus });
}

// Canonical one-line JSON avoids accepting duplicate keys, extensions or
// ambiguously formatted blocks. No I/O or concurrent-edit protection here.
export function readFlowMarker(body) {
  if (typeof body !== 'string') return blocked('invalid-body');
  const start = body.indexOf(START);
  if (start < 0) return body.includes(TAG) ? blocked('malformed-marker') : { kind: 'absent' };
  const end = body.indexOf(END, start + START.length);
  if (end < 0 || body.indexOf(TAG) !== start + '<!-- '.length
    || body.indexOf(TAG, end + END.length) !== -1
    || body.indexOf(TAG, start + START.length) !== end + '\n'.length) return blocked('malformed-marker');
  const raw = body.slice(start + START.length, end);
  let marker;
  try { marker = JSON.parse(raw); } catch { return blocked('malformed-marker'); }
  if (encode(marker) !== raw) return blocked('malformed-marker');
  return { kind: 'found', marker };
}

export function replaceFlowMarker(body, expected, next) {
  const result = readFlowMarker(body);
  if (result.kind === 'blocked') return result;
  const encoded = encode(next);
  if (encoded === null) return blocked('invalid-marker');
  if (expected === null && result.kind !== 'absent') return blocked('marker-conflict');
  if (expected !== null && (result.kind !== 'found' || encode(expected) === null
    || encode(expected) !== encode(result.marker))) return blocked('marker-conflict');
  const block = `${START}${encoded}${END}`;
  if (result.kind === 'absent') return { kind: 'updated', body: `${body}${body ? '\n\n' : ''}${block}` };
  const start = body.indexOf(START);
  const end = body.indexOf(END, start + START.length) + END.length;
  return { kind: 'updated', body: `${body.slice(0, start)}${block}${body.slice(end)}` };
}

// Remove only the verified managed block; do not normalize or trim user text.
// A missing marker is a no-op only when the caller explicitly expects null.
export function removeFlowMarker(body, expected) {
  const result = readFlowMarker(body);
  if (result.kind === 'blocked') return result;
  if (result.kind === 'absent') return expected === null ? { kind: 'unchanged', body } : blocked('marker-conflict');
  if (expected === null || encode(expected) === null || encode(expected) !== encode(result.marker)) return blocked('marker-conflict');
  const start = body.indexOf(START);
  const end = body.indexOf(END, start + START.length) + END.length;
  return { kind: 'updated', body: `${body.slice(0, start)}${body.slice(end)}` };
}
