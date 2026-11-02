import { createHash } from 'node:crypto';

const validTime = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value.replace('Z', '.000Z');

// This checks that independently obtained evidence describes this exact
// snapshot. It does not authenticate objects or make the snapshot atomic.
export const matchesHandoffEpoch = (input, comment, proof) => typeof input.issueNodeId === 'string' && !!input.issueNodeId
  && comment && typeof comment.body === 'string' && typeof comment.id === 'string' && /^[1-9][0-9]*$/.test(comment.id)
  && typeof comment.nodeId === 'string' && !!comment.nodeId && validTime(comment.createdAt)
  && proof?.kind === 'handoff-epoch-evidence' && proof.issueNodeId === input.issueNodeId
  && proof.commentId === comment.id && proof.commentNodeId === comment.nodeId
  && proof.commentCreatedAt === comment.createdAt
  && proof.commentDigest === createHash('sha256').update(comment.body, 'utf8').digest('hex')
  && ['initial', 'reopened'].includes(input.epoch?.kind) && typeof input.epoch?.anchor === 'string' && !!input.epoch.anchor
  && proof.epoch?.kind === input.epoch.kind && proof.epoch?.anchor === input.epoch.anchor;
