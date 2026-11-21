import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DATA,
  CliError,
  init,
  readState,
  statePath,
  phaseView,
  addEvidence,
  decideGate,
  nextView,
} from '../src/core.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/agency.mjs');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agency-runner-'));
}

function cli(dir, ...args) {
  return execFileSync(process.execPath, [BIN, ...args], { cwd: dir, encoding: 'utf8' });
}

test('phase data is complete and ordered', () => {
  assert.equal(DATA.phases.length, 7);
  assert.deepEqual(DATA.phases.map((p) => p.id), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(DATA.phases.map((p) => p.criteria.length), [6, 7, 8, 7, 7, 7, 13]);
  for (const p of DATA.phases) {
    assert.ok(p.name && p.objective && p.gateKeeper);
    assert.ok(p.agents.length > 0);
    assert.match(p.source, /^https:\/\/github\.com\/msitarzewski\/agency-agents\//);
    assert.deepEqual(
      p.criteria.map((c) => c.n),
      p.criteria.map((_, i) => i + 1),
    );
  }
});

test('init creates state and refuses to overwrite', () => {
  const dir = tmp();
  const state = init(dir);
  assert.ok(fs.existsSync(statePath(dir)));
  assert.equal(state.phase, 0);
  assert.equal(state.phases[0].status, 'active');
  assert.equal(state.phases[1].status, 'locked');
  assert.throws(() => init(dir), /already exists/);

  const forced = init(dir, { force: true, runbook: 'incident-response' });
  assert.equal(forced.runbook, 'incident-response');
  assert.equal(readState(dir).runbook, 'incident-response');
});

test('gate is blocked until every criterion has evidence', () => {
  const dir = tmp();
  const state = init(dir);
  assert.throws(
    () => decideGate(dir, state, { pass: true }),
    (err) => err instanceof CliError && err.exitCode === 2 && /gate blocked: 6 of 6/.test(err.message),
  );
  assert.equal(readState(dir).phase, 0);
});

test('evidence validates its argument', () => {
  const dir = tmp();
  const state = init(dir);
  assert.throws(() => addEvidence(dir, state, 0, 'x'), /1\.\.6/);
  assert.throws(() => addEvidence(dir, state, 99, 'x'), /1\.\.6/);
  assert.throws(() => addEvidence(dir, state, 1, '   '), /needs a path or a note/);
  assert.throws(() => addEvidence(dir, state, 1, 'reports/missing.md'), /evidence not found/);
  assert.doesNotThrow(() => addEvidence(dir, state, 1, 'https://example.com/x'));
});

test('evidence accepts an existing file or a plain note', () => {
  const dir = tmp();
  const state = init(dir);
  fs.mkdirSync(path.join(dir, 'reports'));
  fs.writeFileSync(path.join(dir, 'reports', 'market.md'), '# market\n');
  assert.equal(addEvidence(dir, state, 1, 'reports/market.md').done, 1);
  assert.equal(addEvidence(dir, state, 2, 'interviewed 5 users, notes in the call log').done, 2);
  assert.equal(fs.existsSync(statePath(dir)), true);
});

test('gate re-checks that evidence paths still exist', () => {
  const dir = tmp();
  const state = init(dir);
  fs.mkdirSync(path.join(dir, 'reports'));
  for (let n = 1; n <= 6; n++) {
    fs.writeFileSync(path.join(dir, 'reports', `p${n}.md`), 'x');
    addEvidence(dir, state, n, `reports/p${n}.md`);
  }
  fs.rmSync(path.join(dir, 'reports', 'p3.md'));
  assert.throws(
    () => decideGate(dir, state, { pass: true }),
    (err) => err instanceof CliError && err.exitCode === 2 && /no longer exist/.test(err.message),
  );
  const forced = decideGate(dir, state, { pass: true, force: true, note: 'artifact deleted on purpose' });
  assert.equal(forced.passed, true);
  assert.equal(forced.phaseState.gate.forced, true);
});

test('evidence is fingerprinted and the gate notices edits', () => {
  const dir = tmp();
  const state = init(dir);
  fs.mkdirSync(path.join(dir, 'reports'));
  const file = path.join(dir, 'reports', 'market.md');
  fs.writeFileSync(file, '# market v1\n');
  addEvidence(dir, state, 1, 'reports/market.md');
  const entry = readState(dir).phases[0].evidence[1];
  assert.match(entry.sha256, /^[0-9a-f]{64}$/);
  assert.equal(entry.bytes, 12);

  for (let n = 2; n <= 6; n++) addEvidence(dir, state, n, `interviewed user ${n}`);
  fs.writeFileSync(file, '# market v2\n');
  assert.throws(
    () => decideGate(dir, state, { pass: true }),
    (err) => err instanceof CliError && err.exitCode === 2 && /changed since recording/.test(err.message),
  );
  const forced = decideGate(dir, state, { pass: true, force: true, note: 'report edited after review' });
  assert.equal(forced.phaseState.gate.forced, true);
});

test('gate passes, advances, and persists', () => {
  const dir = tmp();
  const state = init(dir);
  fs.mkdirSync(path.join(dir, 'reports'));
  for (let n = 1; n <= 6; n++) {
    fs.writeFileSync(path.join(dir, 'reports', `p0-${n}.md`), 'x');
    addEvidence(dir, state, n, `reports/p0-${n}.md`);
  }

  const result = decideGate(dir, state, { pass: true, note: 'market validated' });
  assert.equal(result.next, 1);
  assert.equal(result.complete, false);

  const saved = readState(dir);
  assert.equal(saved.phase, 1);
  assert.equal(saved.phases[0].status, 'passed');
  assert.equal(saved.phases[0].gate.status, 'passed');
  assert.equal(saved.phases[1].status, 'active');
  assert.equal(saved.log.at(-1).message.includes('gate PASSED'), true);
});

test('failed gate keeps the phase and escalates after three attempts', () => {
  const dir = tmp();
  const state = init(dir);
  assert.throws(() => decideGate(dir, state, { pass: false }), /needs --note/);

  assert.equal(decideGate(dir, state, { pass: false, note: 'no' }).escalated, false);
  assert.equal(decideGate(dir, state, { pass: false, note: 'still no' }).escalated, false);
  assert.equal(decideGate(dir, state, { pass: false, note: 'third' }).escalated, true);

  const saved = readState(dir);
  assert.equal(saved.phase, 0);
  assert.equal(saved.phases[0].attempts, 3);
});

test('forced gate pass needs a reason and is recorded', () => {
  const dir = tmp();
  const state = init(dir);
  assert.throws(() => decideGate(dir, state, { pass: true, force: true }), /--force needs --note/);

  const result = decideGate(dir, state, { pass: true, force: true, note: 'accepting known risk' });
  assert.equal(result.phaseState.gate.forced, true);
  assert.equal(readState(dir).phases[0].gate.forced, true);
});

test('prompt names the phase, roles and gate keeper', () => {
  const dir = tmp();
  const state = init(dir);
  const prompt = nextView(state).prompt;
  assert.match(prompt, /Phase 0 — Discovery/);
  assert.match(prompt, /Executive Summary Generator/);
  assert.match(prompt, /agency evidence/);
  assert.match(prompt, /\.agency\/artifacts\/phase-0\//);
});

test('a full run reaches steady state', () => {
  const dir = tmp();
  const state = init(dir);
  fs.writeFileSync(path.join(dir, 'evidence.md'), 'x');
  for (const phase of DATA.phases) {
    for (const criterion of phase.criteria) addEvidence(dir, state, criterion.n, 'evidence.md');
    decideGate(dir, state, { pass: true, note: `phase ${phase.id} done` });
  }
  const saved = readState(dir);
  assert.equal(saved.complete, true);
  assert.equal(saved.phases[5].status, 'passed');
  assert.equal(saved.phases[6].status, 'passed');
  assert.throws(() => decideGate(dir, saved, { pass: true, note: 'again' }), /already complete/);
});

test('CLI: init → status → evidence → blocked gate → pass', () => {
  const dir = tmp();
  assert.match(cli(dir, 'init'), /initialized/);

  const status = JSON.parse(cli(dir, 'status', '--json'));
  assert.equal(status.phase, 0);
  assert.equal(status.phases.length, 7);
  assert.equal(status.phases[0].evidenceCount, 0);

  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'docs', 'market.md'), '# market\n');
  cli(dir, 'evidence', '1', 'docs/market.md');
  const next = JSON.parse(cli(dir, 'next', '--json'));
  assert.equal(next.done, 1);
  assert.equal(next.criteria[0].note, 'docs/market.md');

  const human = cli(dir, 'next');
  assert.match(human, /Phase 0 — Discovery/);
  assert.match(human, /gate keeper: Executive Summary Generator/);
  assert.match(human, /paste into your agent/);

  const promptOnly = cli(dir, 'next', '--prompt-only');
  assert.match(promptOnly, /Phase 0 — Discovery/);
  assert.doesNotMatch(promptOnly, /paste into your agent/);

  try {
    cli(dir, 'gate', '--pass');
    assert.fail('gate should be blocked');
  } catch (err) {
    assert.equal(err.status, 2);
    assert.match(err.stderr, /gate blocked: 5 of 6/);
  }

  for (let n = 2; n <= 6; n++) {
    fs.writeFileSync(path.join(dir, 'docs', `p0-${n}.md`), 'x');
    cli(dir, 'evidence', String(n), `docs/p0-${n}.md`);
  }
  assert.match(cli(dir, 'gate', '--pass', '--note', 'done'), /gate passed/);

  const after = JSON.parse(cli(dir, 'status', '--json'));
  assert.equal(after.phase, 1);
  assert.equal(after.phases[0].status, 'passed');
});

test('CLI: unknown command and missing run fail cleanly', () => {
  const dir = tmp();
  assert.throws(() => cli(dir, 'status'), (err) => err.status === 1 && /run "agency init"/.test(err.stderr));
  assert.throws(() => cli(dir, 'nope'), (err) => err.status === 1 && /unknown command/.test(err.stderr));
  assert.match(cli(dir, 'init'), /initialized/);
  assert.throws(() => cli(dir, 'init'), (err) => err.status === 1 && /already exists/.test(err.stderr));
});
