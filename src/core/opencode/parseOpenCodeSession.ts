import type Database from 'better-sqlite3';
import { AppEntry, Stats, TokenCounts, buildCmd } from '../LogParser';
import { mapOpenCodeTool } from './toolMap';

interface OpenCodeMessageData {
  role: 'user' | 'assistant';
  modelID?: string;
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
}

interface OpenCodePartData {
  type: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: {
    status?: string;
    input?: Record<string, unknown>;
    output?: unknown;
  };
}

export interface OpenCodeSessionParse {
  entries: AppEntry[];
  stats: Stats;
  model: string;
  modelCounts: Record<string, number>;
}

function emptyStats(): Stats {
  return {
    tokens: { input: 0, output: 0, cache_read: 0, cache_create: 0, reasoning: 0 },
    tools: {},
    timeline: [],
    agentRole: '',
  };
}

// Builds AppEntry[] following the same flat action_id (pre/post) convention as
// Claude's LogParser — confirmed against a real opencode.db (Phase 0 recon):
// tool parts carry a flat `callID` matched between the pre entry (state.input)
// and the post entry (state.output on completion), not a parent/child tree.
export function parseOpenCodeSession(db: Database.Database, sessionId: string): OpenCodeSessionParse {
  const stats = emptyStats();
  const entries: AppEntry[] = [];
  const modelCounts: Record<string, number> = {};

  const messages = db
    .prepare('SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id')
    .all(sessionId) as Array<{ id: string; time_created: number; data: string }>;

  if (!messages.length) return { entries, stats, model: '', modelCounts };

  const partRows = db
    .prepare('SELECT id, message_id, time_created, data FROM part WHERE session_id = ? ORDER BY time_created, id')
    .all(sessionId) as Array<{ id: string; message_id: string; time_created: number; data: string }>;

  const partsByMessage = new Map<string, typeof partRows>();
  for (const p of partRows) {
    const list = partsByMessage.get(p.message_id) ?? [];
    list.push(p);
    partsByMessage.set(p.message_id, list);
  }

  for (const msg of messages) {
    let msgData: OpenCodeMessageData;
    try {
      msgData = JSON.parse(msg.data);
    } catch {
      continue;
    }

    const msgParts = partsByMessage.get(msg.id) ?? [];
    const ts = new Date(msg.time_created).toISOString();

    if (msgData.role === 'user') {
      for (const p of msgParts) {
        let pd: OpenCodePartData;
        try {
          pd = JSON.parse(p.data);
        } catch {
          continue;
        }
        if (pd.type !== 'text') continue;
        const text = (pd.text || '').trim();
        if (!text) continue;
        entries.push({
          ts: new Date(p.time_created).toISOString(),
          action_id: p.id,
          parent_id: null,
          child_ids: [],
          event: 'prompt',
          tool: 'User',
          cmd: text.slice(0, 120),
          input: { message: text },
          tokens: null,
        });
      }
      continue;
    }

    if (msgData.role !== 'assistant') continue;

    if (msgData.modelID) modelCounts[msgData.modelID] = (modelCounts[msgData.modelID] || 0) + 1;

    const t = msgData.tokens;
    const turnTokens: TokenCounts = {
      input: t?.input || 0,
      output: t?.output || 0,
      cache_read: t?.cache?.read || 0,
      cache_create: t?.cache?.write || 0,
      reasoning: t?.reasoning || 0,
    };
    const hasTokens = !!(
      turnTokens.input || turnTokens.output || turnTokens.cache_read || turnTokens.cache_create || turnTokens.reasoning
    );
    if (hasTokens) {
      stats.tokens.input += turnTokens.input;
      stats.tokens.output += turnTokens.output;
      stats.tokens.cache_read += turnTokens.cache_read;
      stats.tokens.cache_create += turnTokens.cache_create;
      stats.tokens.reasoning = (stats.tokens.reasoning || 0) + (turnTokens.reasoning || 0);
    }

    const toolNames: string[] = [];
    const agentNames: string[] = [];
    let toolIdx = 0;

    for (const p of msgParts) {
      let pd: OpenCodePartData;
      try {
        pd = JSON.parse(p.data);
      } catch {
        continue;
      }
      if (pd.type !== 'tool' || !pd.tool || !pd.callID) continue;

      const rawInput = pd.state?.input || {};
      const mapped = mapOpenCodeTool(pd.tool, rawInput);
      toolNames.push(mapped.tool);
      stats.tools[mapped.tool] = (stats.tools[mapped.tool] || 0) + 1;

      if (mapped.tool === 'Agent') {
        agentNames.push(String(rawInput.subagent_type || rawInput.agent || 'general-purpose'));
      }

      entries.push({
        ts,
        action_id: pd.callID,
        parent_id: null,
        child_ids: [],
        event: 'pre',
        tool: mapped.tool,
        cmd: buildCmd(mapped.tool, mapped.input),
        input: mapped.input,
        tokens: toolIdx === 0 ? turnTokens : null,
      });

      const status = pd.state?.status;
      if (status === 'completed' || status === 'error') {
        const output = pd.state?.output;
        entries.push({
          ts,
          action_id: pd.callID,
          parent_id: null,
          child_ids: [],
          event: 'post',
          tool: '',
          cmd: '',
          input: {},
          tokens: null,
          response: typeof output === 'string' ? output : output != null ? JSON.stringify(output) : '',
        });
      }

      toolIdx++;
    }

    if (hasTokens) {
      stats.timeline.push({
        ts,
        input: turnTokens.input,
        output: turnTokens.output,
        cache_read: turnTokens.cache_read,
        cache_create: turnTokens.cache_create,
        tools: toolNames,
        skills: [],
        agents: agentNames,
      });
    }
  }

  let dominantModel = '';
  let maxCount = 0;
  for (const [m, c] of Object.entries(modelCounts)) {
    if (c > maxCount) {
      dominantModel = m;
      maxCount = c;
    }
  }

  return { entries, stats, model: dominantModel, modelCounts };
}
