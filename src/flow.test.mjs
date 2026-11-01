import test from 'node:test';
import assert from 'node:assert/strict';
import { FLOW_STATUSES, parseFlowComment } from './flow.mjs';

const comment = (status = 'agent-ready') => `[FLOW]\nRola: Designer\nStan docelowy: ${status}\nWykonano: Gotowe\nNastępny krok: Coder działa`;

test('accepts all statuses and returns the exact fields', () => {
  for (const status of FLOW_STATUSES) {
    assert.deepEqual(parseFlowComment(comment(status)), {
      ok: true, role: 'Designer', targetStatus: status, completed: 'Gotowe', nextStep: 'Coder działa',
    });
  }
});

test('accepts CRLF, optional final newline and surrounding value spaces', () => {
  const input = '[FLOW]\r\nRola:  Smoker  \r\nStan docelowy: smoke\r\nWykonano:  Gotowe \r\nNastępny krok: Weryfikacja\r\n';
  assert.deepEqual(parseFlowComment(input), { ok: true, role: 'Smoker', targetStatus: 'smoke', completed: 'Gotowe', nextStep: 'Weryfikacja' });
});

test('rejects malformed and ambiguous comments without partial result', () => {
  const invalid = [null, 42, {}, '', comment('other'), comment('Smoke'),
    comment().replace('Rola: Designer', 'Rola: '),
    comment().replace('Wykonano: Gotowe\n', ''),
    comment().replace('Wykonano: Gotowe', 'Rola: Designer'),
    comment().replace('Wykonano: Gotowe', 'Wykonano: Gotowe\nDrugi wiersz'),
    `${comment()}\nRola: Inny`, `${comment()}\n\n`,
    comment().replace('[FLOW]', ' [FLOW]'), comment().replace('Rola:', 'rola:'),
    comment().replace('Gotowe', 'Gotowe\rDruga linia')];
  for (const input of invalid) assert.deepEqual(parseFlowComment(input), { ok: false, error: 'Invalid FLOW comment' });
});
