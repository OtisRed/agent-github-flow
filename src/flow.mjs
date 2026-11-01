export const FLOW_STATUSES = Object.freeze([
  'decision-gate', 'needs-design', 'audit', 'spike',
  'agent-ready', 'review', 'smoke', 'done',
]);

const fields = ['Rola', 'Stan docelowy', 'Wykonano', 'Następny krok'];

export function parseFlowComment(body) {
  const invalid = () => ({ ok: false, error: 'Invalid FLOW comment' });
  if (typeof body !== 'string') return invalid();

  const lines = body.split(/\r\n|\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length !== 5 || lines[0] !== '[FLOW]') return invalid();

  const values = [];
  for (let i = 0; i < fields.length; i += 1) {
    const prefix = `${fields[i]}:`;
    if (!lines[i + 1].startsWith(prefix)) return invalid();
    const value = lines[i + 1].slice(prefix.length).trim();
    if (!value || /[\r\n]/.test(value)) return invalid();
    values.push(value);
  }
  if (!FLOW_STATUSES.includes(values[1])) return invalid();
  return { ok: true, role: values[0], targetStatus: values[1], completed: values[2], nextStep: values[3] };
}
