import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DATA = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'data/nexus.json'), 'utf8'));
export const PACKAGE = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'));

export const STATE_DIR = '.agency';
const STATE_FILE = 'state.json';
const MAX_LOG = 500;

export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export function statePath(dir) {
  return path.join(dir, STATE_DIR, STATE_FILE);
}

export function findRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(statePath(dir))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function readState(dir) {
  const file = statePath(dir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new CliError(`no run found under ${dir}; run "agency init" first`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new CliError(`state file is corrupt: ${file}`);
  }
}

export function writeState(dir, state) {
  state.updated = new Date().toISOString();
  const file = statePath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function init(dir, { runbook = 'startup-mvp', force = false } = {}) {
  const file = statePath(dir);
  if (fs.existsSync(file) && !force) {
    throw new CliError(`a run already exists at ${file} (use --force to reset)`);
  }
  const now = new Date().toISOString();
  const state = {
    version: 1,
    runbook,
    created: now,
    updated: now,
    phase: 0,
    complete: false,
    phases: Object.fromEntries(
      DATA.phases.map((p) => [
        p.id,
        { status: p.id === 0 ? 'active' : 'locked', evidence: {}, gate: null, attempts: 0 },
      ]),
    ),
    log: [{ at: now, message: `run initialized (${runbook})` }],
  };
  writeState(dir, state);
  return state;
}

export function currentPhase(state) {
  const meta = DATA.phases.find((p) => p.id === state.phase);
  if (!meta) throw new CliError(`state points at unknown phase ${state.phase}`);
  return meta;
}

export function phaseView(state) {
  const meta = currentPhase(state);
  const phaseState = state.phases[meta.id];
  if (!phaseState) throw new CliError(`state has no record for phase ${meta.id}`);
  const criteria = meta.criteria.map((c) => {
    const entry = phaseState.evidence[c.n];
    return { ...c, done: Boolean(entry), note: entry?.note ?? null };
  });
  const done = criteria.filter((c) => c.done).length;
  return { meta, phaseState, criteria, done, total: criteria.length };
}

function addLog(state, message) {
  state.log.push({ at: new Date().toISOString(), message });
  if (state.log.length > MAX_LOG) state.log = state.log.slice(-MAX_LOG);
}

export function addEvidence(dir, state, n, note) {
  const { meta, phaseState, criteria, done, total } = phaseView(state);
  const idx = Number(n);
  if (!Number.isInteger(idx) || idx < 1 || idx > criteria.length) {
    throw new CliError(`criterion must be 1..${criteria.length} in phase ${meta.id}`);
  }
  const text = String(note ?? '').trim();
  if (!text) throw new CliError('evidence needs a path or a note');
  const had = Boolean(phaseState.evidence[idx]);
  phaseState.evidence[idx] = { note: text, at: new Date().toISOString() };
  addLog(state, `phase ${meta.id}: evidence #${idx} → ${text}`);
  writeState(dir, state);
  return { meta, phaseState, criterion: idx, done: done + (had ? 0 : 1), total };
}

export function decideGate(dir, state, { pass, note, force = false }) {
  if (state.complete) throw new CliError('run is already complete');
  const { meta, phaseState, done, total } = phaseView(state);
  const text = String(note ?? '').trim();
  const missing = total - done;

  if (!pass) {
    if (!text) throw new CliError('a failed gate needs --note explaining why');
    phaseState.gate = { status: 'failed', at: new Date().toISOString(), note: text };
    phaseState.attempts += 1;
    addLog(state, `phase ${meta.id}: gate FAILED (attempt ${phaseState.attempts}) — ${text}`);
    writeState(dir, state);
    return { meta, phaseState, passed: false, escalated: phaseState.attempts >= 3, missing, complete: false };
  }

  if (missing > 0 && !force) {
    throw new CliError(
      `gate blocked: ${missing} of ${total} criteria have no evidence (record them, or --force --note "<reason>")`,
      2,
    );
  }
  if (force && !text) throw new CliError('--force needs --note explaining the override');

  phaseState.gate = {
    status: 'passed',
    at: new Date().toISOString(),
    note: text || 'all criteria evidenced',
    forced: force && missing > 0,
  };
  phaseState.status = 'passed';
  addLog(state, `phase ${meta.id}: gate PASSED${phaseState.gate.forced ? ' (forced)' : ''} — ${phaseState.gate.note}`);

  let next = null;
  if (meta.terminal) {
    state.complete = true;
  } else {
    next = meta.id + 1;
    state.phase = next;
    state.phases[next].status = 'active';
  }
  writeState(dir, state);
  return { meta, phaseState, passed: true, escalated: false, missing, complete: state.complete, next };
}

export function addLogEntry(dir, state, message) {
  const text = String(message ?? '').trim();
  if (!text) throw new CliError('log needs a message');
  addLog(state, text);
  writeState(dir, state);
}

export function phasePrompt(state) {
  const { meta, criteria } = phaseView(state);
  return [
    `You are the Agents Orchestrator for Phase ${meta.id} — ${meta.name}.`,
    '',
    `Objective: ${meta.objective}`,
    '',
    `Activate these roles: ${meta.agents.join(', ')}.`,
    `Read the full playbook first: ${meta.source}`,
    '',
    `Write every deliverable under .agency/artifacts/phase-${meta.id}/ and refer to it by path.`,
    'Do not claim a criterion is met without an artifact a reviewer can open.',
    '',
    'Gate criteria (all must be evidenced):',
    ...criteria.map((c) => `${c.n}. ${c.text} — evidence: ${c.evidence}`),
    '',
    `Gate keeper: ${meta.gateKeeper}.`,
    'When the work is done, the operator records evidence with',
    '"agency evidence <n> <path-or-note>" and runs agency gate --pass --note "<summary>".',
  ].join('\n');
}

export function nextView(state) {
  const { meta, phaseState, criteria, done, total } = phaseView(state);
  return {
    runbook: state.runbook,
    complete: state.complete,
    phase: meta,
    phaseState: { status: phaseState.status, gate: phaseState.gate, attempts: phaseState.attempts },
    criteria,
    done,
    total,
    prompt: state.complete ? null : phasePrompt(state),
  };
}
