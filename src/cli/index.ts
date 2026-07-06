#!/usr/bin/env node
import http from 'http';
import https from 'https';
import { URL } from 'url';

const BASE = process.env.LOOMSCOPE_API ?? 'http://127.0.0.1:7842';

interface SessionInfo {
  session_id: string;
  project: string;
  event_count: number;
  first_ts: string;
  last_ts: string;
  model?: string;
  title?: string;
}

interface BpmnProcess {
  processId: string;
  name: string;
  elements: unknown[];
  flows: unknown[];
}

interface SessionSummary {
  session_id: string;
  project: string;
  title: string;
  model: string;
  model_counts: Record<string, number>;
  start_ts: string;
  stop_ts: string;
  duration_ms: number;
  duration_human: string;
  tokens: { input: number; output: number; cache_read: number; cache_create: number };
  tools: Record<string, number>;
  bpmn: BpmnProcess;
}

interface FlowStep {
  index: number;
  ts: string;
  event: 'prompt' | 'command' | 'tool' | 'response';
  tool: string;
  summary: string;
  depth: number;
  attribution?: { skill: string; agent: string; plugin: string } | null;
  skill?: { plugin: string; name: string } | null;
}

function request<T>(pathStr: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const url = new URL(pathStr, BASE);
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf-8');
        if (!res.statusCode || res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          return;
        }
        try {
          resolve(JSON.parse(body) as T);
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15_000, () => req.destroy(new Error('request timeout')));
  });
}

function fmtTs(ts: string): string {
  return ts ? ts.replace('T', ' ').slice(0, 19) : '?';
}

function eventGlyph(ev: FlowStep['event']): string {
  switch (ev) {
    case 'prompt':
      return '›';
    case 'command':
      return '$';
    case 'tool':
      return '·';
    default:
      return ' ';
  }
}

async function cmdSessionsList(): Promise<void> {
  const list = await request<SessionInfo[]>('/api/sessions');
  if (!list.length) {
    console.log('No sessions found.');
    return;
  }
  const rows = list.slice(0, 50).map((s) => ({
    id: s.session_id.slice(0, 8),
    events: String(s.event_count).padStart(5),
    last: fmtTs(s.last_ts),
    project: s.project,
  }));
  const widths = {
    id: Math.max(8, ...rows.map((r) => r.id.length)),
    events: 5,
    last: 19,
  };
  console.log(
    `${'ID'.padEnd(widths.id)}  ${'EVENTS'.padStart(widths.events)}  ${'LAST'.padEnd(widths.last)}  PROJECT`,
  );
  for (const r of rows) {
    console.log(
      `${r.id.padEnd(widths.id)}  ${r.events.padStart(widths.events)}  ${r.last.padEnd(widths.last)}  ${r.project}`,
    );
  }
  if (list.length > 50) console.log(`… ${list.length - 50} more`);
}

// Resolves a query that is either a session-id prefix (>= 4 chars, or a full
// UUID) or a case-insensitive substring of a session's title.
async function resolveSessionId(query: string): Promise<string> {
  if (query.length >= 32) return query;
  const list = await request<SessionInfo[]>('/api/sessions');

  const idMatches = list.filter((s) => s.session_id.startsWith(query));
  if (idMatches.length === 1) return idMatches[0].session_id;
  if (idMatches.length > 1) {
    throw new Error(
      `Ambiguous id prefix "${query}" matches ${idMatches.length} sessions; provide more characters.`,
    );
  }

  const q = query.toLowerCase();
  const titleMatches = list.filter((s) => (s.title || '').toLowerCase().includes(q));
  if (!titleMatches.length) throw new Error(`No session matches "${query}"`);
  if (titleMatches.length > 1) {
    const preview = titleMatches
      .slice(0, 5)
      .map((s) => `  ${s.session_id.slice(0, 8)}  ${s.title}`)
      .join('\n');
    throw new Error(
      `Ambiguous title "${query}" matches ${titleMatches.length} sessions:\n${preview}\nProvide a more specific title or a session id.`,
    );
  }
  return titleMatches[0].session_id;
}

async function cmdFlow(prefix: string): Promise<void> {
  const id = await resolveSessionId(prefix);
  const data = await request<{ session_id: string; steps: FlowStep[] }>(
    `/api/sessions/${encodeURIComponent(id)}/flow`,
  );
  console.log(`Flow for session ${data.session_id} (${data.steps.length} steps)\n`);
  for (const step of data.steps) {
    const indent = '  '.repeat(Math.min(step.depth, 12));
    const glyph = eventGlyph(step.event);
    const tool = step.tool || step.event;
    const attr =
      step.attribution && (step.attribution.agent || step.attribution.skill || step.attribution.plugin)
        ? `  ‹${[step.attribution.plugin, step.attribution.skill || step.attribution.agent]
            .filter(Boolean)
            .join(':')}›`
        : '';
    const skill = step.skill ? `  [SKILL ${step.skill.plugin}:${step.skill.name}]` : '';
    const summary = step.summary ? `  ${step.summary}` : '';
    console.log(
      `${fmtTs(step.ts)}  ${indent}${glyph} ${tool}${summary}${attr}${skill}`,
    );
  }
}

async function cmdStats(prefix: string): Promise<void> {
  const id = await resolveSessionId(prefix);
  const stats = await request<{
    tokens?: { input: number; output: number; cache_read: number; cache_create: number };
    tools?: Record<string, number>;
    agentRole?: string;
  }>(`/api/sessions/${encodeURIComponent(id)}/stats`);
  console.log(`Stats for session ${id}`);
  if (stats.agentRole) console.log(`  agentRole: ${stats.agentRole}`);
  if (stats.tokens) {
    console.log(
      `  tokens: in=${stats.tokens.input}  out=${stats.tokens.output}  cache_read=${stats.tokens.cache_read}  cache_create=${stats.tokens.cache_create}`,
    );
  }
  if (stats.tools && Object.keys(stats.tools).length) {
    console.log('  tools:');
    for (const [k, v] of Object.entries(stats.tools).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${k.padEnd(24)} ${v}`);
    }
  }
}

async function cmdSummary(query: string): Promise<void> {
  const id = await resolveSessionId(query);
  const s = await request<SessionSummary>(`/api/sessions/${encodeURIComponent(id)}/summary`);
  console.log(`Session ${s.session_id}`);
  console.log(`  Title:    ${s.title || '(untitled)'}`);
  console.log(`  Project:  ${s.project}`);
  console.log(`  Model:    ${s.model}${
    Object.keys(s.model_counts).length > 1
      ? '  (' + Object.entries(s.model_counts).map(([m, c]) => `${m}=${c}`).join(', ') + ')'
      : ''
  }`);
  console.log(`  Start:    ${fmtTs(s.start_ts)}`);
  console.log(`  Stop:     ${fmtTs(s.stop_ts)}`);
  console.log(`  Duration: ${s.duration_human} (${s.duration_ms} ms)`);
  console.log(
    `  Tokens:   in=${s.tokens.input}  out=${s.tokens.output}  cache_read=${s.tokens.cache_read}  cache_create=${s.tokens.cache_create}`,
  );
  console.log('\nBPMN process (JSON):');
  console.log(JSON.stringify(s.bpmn, null, 2));
}

async function cmdTeams(): Promise<void> {
  const teams = await request<Array<{ name: string; size?: number }>>('/api/teams');
  if (!teams.length) {
    console.log('No teams found.');
    return;
  }
  for (const t of teams) console.log(`- ${t.name}`);
}

function help(): void {
  console.log(`loomscope — CLI for the LoomScope REST API

Usage:
  loomscope sessions                     List recent sessions
  loomscope flow <session-id-or-title>   Print step-by-step flow for a session
  loomscope stats <session-id-or-title>  Print token + tool stats for a session
  loomscope summary <session-id-or-title>
                                          Print start/stop time, duration, token
                                          stats, model used, and a JSON BPMN
                                          breakdown of the session's phases
  loomscope teams                        List agent teams
  loomscope --help                       Show this help

Environment:
  LOOMSCOPE_API   Base URL of the API server (default: ${BASE})

Sessions may be identified by any unique session-id prefix (≥ 4 chars), a
full session id, or a case-insensitive substring of the session's title.`);
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  try {
    switch (cmd) {
      case undefined:
      case '-h':
      case '--help':
        help();
        return;
      case 'sessions':
      case 'ls':
        await cmdSessionsList();
        return;
      case 'flow':
        if (!rest[0]) throw new Error('flow requires a session id');
        await cmdFlow(rest[0]);
        return;
      case 'stats':
        if (!rest[0]) throw new Error('stats requires a session id');
        await cmdStats(rest[0]);
        return;
      case 'summary':
        if (!rest[0]) throw new Error('summary requires a session id or title');
        await cmdSummary(rest[0]);
        return;
      case 'teams':
        await cmdTeams();
        return;
      default:
        console.error(`Unknown command: ${cmd}`);
        help();
        process.exitCode = 2;
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
}

void main();
