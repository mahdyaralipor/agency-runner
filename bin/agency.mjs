#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  DATA,
  PACKAGE,
  CliError,
  findRoot,
  readState,
  init,
  addEvidence,
  decideGate,
  addLogEntry,
  nextView,
} from '../src/core.mjs';

const USAGE = `agency-runner — run the agency-agents NEXUS pipeline as a gated workflow

Usage:
  agency init [--runbook <name>] [--force]
  agency status [--json]
  agency next [--json] [--prompt-only]
  agency evidence <n> <path-or-note>
  agency gate --pass|--fail [--note "<reason>"] [--force]
  agency log "<message>"

Runbooks: startup-mvp, enterprise-feature, incident-response, marketing-campaign
State lives in .agency/state.json. The CLI never calls an LLM: it prepares the
phase brief and prompt, you run it in any agent tool, then you record evidence.
`;

const ICON = { passed: '✓', active: '▶', locked: '○' };

function projectDir() {
  const dir = findRoot();
  if (!dir) throw new CliError('no .agency run found here or above; run "agency init" first');
  return dir;
}

function phaseName(id) {
  return DATA.phases.find((p) => p.id === id)?.name ?? `phase ${id}`;
}

function printStatus(state, dir, json) {
  if (json) {
    const view = {
      version: PACKAGE.version,
      runbook: state.runbook,
      phase: state.phase,
      complete: state.complete,
      phases: DATA.phases.map((p) => ({
        id: p.id,
        name: p.name,
        ...state.phases[p.id],
        evidenceCount: Object.keys(state.phases[p.id].evidence).length,
        criterionCount: p.criteria.length,
      })),
    };
    console.log(JSON.stringify(view, null, 2));
    return;
  }

  console.log(`agency-runner ${PACKAGE.version} · runbook: ${state.runbook}`);
  console.log(`project: ${dir}`);
  console.log('');
  for (const p of DATA.phases) {
    const s = state.phases[p.id];
    const current = p.id === state.phase && !state.complete;
    const evidence = current ? `   evidence ${Object.keys(s.evidence).length}/${p.criteria.length}` : '';
    const gate =
      s.gate?.status === 'passed'
        ? '   gate passed'
        : s.gate?.status === 'failed'
          ? `   gate failed (${s.attempts}/3)`
          : '';
    console.log(`  ${ICON[s.status]}  ${p.id}  ${p.name}${evidence}${gate}`);
  }
  console.log('');
  console.log(state.complete ? 'Run complete — steady state.' : 'Next: agency next');
}

function printNext(state, json) {
  const view = nextView(state);
  if (json) {
    console.log(JSON.stringify(view, null, 2));
    return;
  }
  if (view.complete) {
    console.log('Run complete — steady state. Nothing to do.');
    return;
  }

  const { phase: meta, criteria, done, total } = view;
  console.log(`Phase ${meta.id} — ${meta.name}`);
  console.log(`gate keeper: ${meta.gateKeeper}`);
  console.log('');
  console.log(meta.objective);
  console.log('');
  console.log(`roles: ${meta.agents.join(', ')}`);
  console.log(`playbook: ${meta.source}`);
  console.log('');
  console.log(`criteria: ${done}/${total} evidenced`);
  for (const c of criteria) {
    console.log(`  ${c.done ? '✓' : '○'} ${c.n}. ${c.text}`);
    const hash = c.sha256 ? `  · sha256:${c.sha256.slice(0, 12)}` : '';
    console.log(`       evidence: ${c.done ? c.note + hash : c.evidence}`);
  }
  console.log('');
  console.log('── paste into your agent ─────────────────────────────────────');
  console.log(view.prompt);
  console.log('──────────────────────────────────────────────────────────────');
}

function main() {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        runbook: { type: 'string' },
        force: { type: 'boolean' },
        json: { type: 'boolean' },
        'prompt-only': { type: 'boolean' },
        pass: { type: 'boolean' },
        fail: { type: 'boolean' },
        note: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (err) {
    throw new CliError(err.message);
  }

  const { values, positionals } = parsed;
  const command = positionals[0];

  if (values.version) {
    console.log(PACKAGE.version);
    return;
  }
  if (!command || command === 'help' || values.help) {
    console.log(USAGE);
    return;
  }

  if (command === 'init') {
    const dir = process.cwd();
    const state = init(dir, { runbook: values.runbook, force: values.force });
    console.log(`initialized .agency/state.json (runbook: ${state.runbook})`);
    console.log('Phase 0 — Discovery. Next: agency next');
    return;
  }

  if (command === 'status') {
    const dir = projectDir();
    printStatus(readState(dir), dir, values.json);
    return;
  }

  if (command === 'next') {
    const state = readState(projectDir());
    if (values['prompt-only']) {
      const view = nextView(state);
      if (view.prompt) process.stdout.write(`${view.prompt}\n`);
      return;
    }
    printNext(state, values.json);
    return;
  }

  if (command === 'evidence') {
    const dir = projectDir();
    const result = addEvidence(dir, readState(dir), positionals[1], positionals.slice(2).join(' '));
    console.log(
      `phase ${result.meta.id}: evidence #${result.criterion} recorded (${result.done}/${result.total})`,
    );
    return;
  }

  if (command === 'gate') {
    if (Boolean(values.pass) === Boolean(values.fail)) {
      throw new CliError('use exactly one of --pass or --fail');
    }
    const dir = projectDir();
    const result = decideGate(dir, readState(dir), {
      pass: Boolean(values.pass),
      note: values.note,
      force: Boolean(values.force),
    });

    if (result.passed) {
      console.log(`gate passed — phase ${result.meta.id} ${result.meta.name}`);
      if (result.complete) console.log('Run complete — steady state.');
      else console.log(`next: phase ${result.next} — ${phaseName(result.next)}`);
      return;
    }

    console.log(`gate failed — attempt ${result.phaseState.attempts}/3`);
    if (result.escalated) console.log('escalate to Studio Producer: fix, descope, or accept with risk.');
    return;
  }

  if (command === 'log') {
    const dir = projectDir();
    addLogEntry(dir, readState(dir), positionals.slice(1).join(' '));
    console.log('logged');
    return;
  }

  throw new CliError(`unknown command "${command}"\n\n${USAGE}`);
}

try {
  main();
} catch (err) {
  const code = err instanceof CliError ? err.exitCode : 1;
  console.error(`error: ${err.message}`);
  process.exitCode = code;
}
