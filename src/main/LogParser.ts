import fs from 'fs';

export interface TokenCounts {
  input: number;
  output: number;
  cache_read: number;
  cache_create: number;
}

export interface AppEntry {
  ts: string;
  action_id: string;
  parent_id: string | null;
  child_ids: string[];
  event: 'pre' | 'post' | 'prompt' | 'command';
  tool: string;
  cmd: string;
  input: Record<string, unknown>;
  tokens: TokenCounts | null;
  response?: unknown;
  skillRead?: { plugin: string; name: string } | null;
  attribution?: { skill: string; agent: string; plugin: string } | null;
}

export interface TimelineEntry {
  ts: string;
  input: number;
  output: number;
  cache_read: number;
  cache_create: number;
  tools: string[];
  skills: string[];   // skill names from Skill tool calls in this turn
  agents: string[];   // agent types from Agent tool calls in this turn
}

export interface Stats {
  tokens: TokenCounts;
  tools: Record<string, number>;
  timeline: TimelineEntry[];
  agentRole: string;   // value from agent-setting entry (e.g. 'api-core-generator')
}

export interface ParseResult {
  entries: AppEntry[];
  stats: Stats;
  lastLine: number;
  agentSetting: string;
  agentName: string;
  teamName: string;
  teamTask: string;
  attributionSkill: string;
  attributionAgent: string;
  attributionPlugin: string;
}

interface NativeContentBlock {
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  text?: string;
}

interface NativeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface NativeMessage {
  role?: string;
  content?: NativeContentBlock[] | string;
  usage?: NativeUsage;
}

interface NativeEntry {
  type: string;
  message?: NativeMessage;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sessionId?: string;
  isSidechain?: boolean;
  agentSetting?: string;
  agentName?: string;
  teamName?: string;
  attributionSkill?: string;
  attributionAgent?: string;
  attributionPlugin?: string;
  attachment?: {
    type: string;
    content?: string;
    skillCount?: number;
    isInitial?: boolean;
    hookName?: string;
    toolUseID?: string;
  };
}

function detectSkillRead(input: Record<string, unknown>): { plugin: string; name: string } | null {
  const path = String(input.file_path || input.path || '');
  if (!path) return null;
  const m = path.match(/skills\/([^/]+)\/SKILL\.md$/i);
  if (!m) return null;
  const folder = m[1];
  const dash = folder.indexOf('-');
  if (dash > -1) return { plugin: folder.slice(0, dash), name: folder.slice(dash + 1) };
  return { plugin: folder, name: folder };
}

// A real skill activation has the plugin:skill form (e.g. /input-analyzer:input-analyzer).
// Bare slash commands like /plugin, /reload-plugins, /clear are built-in Claude Code
// commands, not skills — exclude them.
function detectInjectedSkills(text: string): Array<{ name: string; raw: string }> {
  const out: Array<{ name: string; raw: string }> = [];
  for (const m of text.matchAll(/<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/g)) {
    const name = m[1];
    if (!name.includes(':')) continue;
    out.push({ name, raw: m[0] });
  }
  return out;
}

function buildCmd(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case 'Bash':
      return String(input.description || input.command || '').slice(0, 80);
    case 'Agent':
      return `[${input.agent || input.subagent_type || 'general-purpose'}] ${input.description || ''}`.trim();
    case 'Skill':
      return `${input.skill || ''}${input.args ? ' ' + input.args : ''}`;
    case 'SendMessage':
      return `→ ${input.to || ''}: ${String(input.message || '').slice(0, 80)}`;
    case 'TaskCreate':
      return String(input.title || '');
    case 'TaskUpdate':
      return `${input.id || ''} → ${input.status || ''}`;
    case 'Read':
    case 'Glob':
    case 'Grep':
      return String(input.file_path || input.path || input.pattern || '').split('/').slice(-2).join('/');
    case 'WebFetch':
      return String(input.url || '').replace(/^https?:\/\//, '').slice(0, 80);
    case 'WebSearch':
      return String(input.query || '').slice(0, 80);
    case 'Edit':
    case 'Write':
      return String(input.file_path || '').split('/').slice(-2).join('/');
    default:
      if (tool.startsWith('mcp__')) return tool.replace(/^mcp__[^_]+__/, '');
      return '';
  }
}

function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: NativeContentBlock) => b?.type === 'text')
      .map((b: NativeContentBlock) => b.text || '')
      .join('\n');
  }
  if (content && typeof content === 'object') {
    return JSON.stringify(content).slice(0, 600);
  }
  return String(content ?? '');
}

export function parseFile(filePath: string, fromLine = 0): ParseResult {
  let lines: string[];
  try {
    lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  } catch {
    return { entries: [], stats: emptyStats(), lastLine: fromLine, agentSetting: '', agentName: '', teamName: '', teamTask: '', attributionSkill: '', attributionAgent: '', attributionPlugin: '' };
  }

  const entries: AppEntry[] = [];
  const stats = emptyStats();
  let lastAgentSetting = '';
  let sessionAgentSetting = '';
  let sessionAgentName = '';
  let sessionTeamName = '';
  let sessionTeamTask = '';
  let sessionAttributionSkill = '';
  let sessionAttributionAgent = '';
  let sessionAttributionPlugin = '';

  for (let i = fromLine; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    let obj: NativeEntry;
    try {
      obj = JSON.parse(raw);
    } catch {
      continue;
    }

    if (!obj.type || obj.type === 'queue-operation' || obj.type === 'summary') continue;

    // Capture team/agent metadata from any entry type
    if (obj.teamName && !sessionTeamName) sessionTeamName = String(obj.teamName);
    if (obj.agentName && !sessionAgentName) sessionAgentName = String(obj.agentName);
    if (obj.attributionSkill && !sessionAttributionSkill) sessionAttributionSkill = String(obj.attributionSkill);
    if (obj.attributionAgent && !sessionAttributionAgent) sessionAttributionAgent = String(obj.attributionAgent);
    if (obj.attributionPlugin && !sessionAttributionPlugin) sessionAttributionPlugin = String(obj.attributionPlugin);

    const attribution = (obj.attributionSkill || obj.attributionAgent || obj.attributionPlugin)
      ? {
          skill: String(obj.attributionSkill || ''),
          agent: String(obj.attributionAgent || ''),
          plugin: String(obj.attributionPlugin || ''),
        }
      : null;

    const ts = obj.timestamp || '';

    if (obj.type === 'agent-setting') {
      const skill = String(obj.agentSetting || '').trim();
      if (skill && skill !== lastAgentSetting) {
        if (!sessionAgentSetting) sessionAgentSetting = skill;
        lastAgentSetting = skill;
        entries.push({
          ts,
          action_id: obj.uuid || `setting-${i}`,
          parent_id: null,
          child_ids: [],
          event: 'command',
          tool: 'AgentSetting',
          cmd: skill,
          input: { skill },
          tokens: null,
        });
      }
      continue;
    }

    if (obj.type === 'attachment') {
      if (obj.agentName && !sessionAgentName) sessionAgentName = String(obj.agentName);
      const att = obj.attachment;
      if (att?.type === 'skill_listing' && att.isInitial) {
        const skills: string[] = [];
        if (att.content) {
          for (const m of String(att.content).matchAll(/^- (.+?): /gm)) {
            skills.push(m[1].trim());
          }
        }
        entries.push({
          ts,
          action_id: obj.uuid || `skills-${i}`,
          parent_id: null,
          child_ids: [],
          event: 'command',
          tool: 'SkillListing',
          cmd: `${att.skillCount ?? 0} skills`,
          input: { skillCount: att.skillCount ?? 0, isInitial: true, skills },
          tokens: null,
        });
      }
      continue;
    }

    const msg = obj.message;
    if (!msg) continue;

    if (obj.type === 'assistant') {
      const content = msg.content;
      if (!Array.isArray(content)) continue;

      const toolUses = content.filter(b => b.type === 'tool_use');
      if (!toolUses.length) continue;

      const usage = msg.usage || {};
      const turnTokens: TokenCounts = {
        input: usage.input_tokens || 0,
        output: usage.output_tokens || 0,
        cache_read: usage.cache_read_input_tokens || 0,
        cache_create: usage.cache_creation_input_tokens || 0,
      };

      stats.tokens.input += turnTokens.input;
      stats.tokens.output += turnTokens.output;
      stats.tokens.cache_read += turnTokens.cache_read;
      stats.tokens.cache_create += turnTokens.cache_create;

      const toolNames: string[] = [];
      const skillNames: string[] = [];
      const agentNames: string[] = [];
      toolUses.forEach((tu, idx) => {
        const toolName = tu.name || 'Unknown';
        const input = tu.input || {};
        toolNames.push(toolName);
        if (toolName === 'Skill' && input.skill) skillNames.push(String(input.skill));
        if (toolName === 'Agent' && (input.subagent_type || input.agent)) {
          agentNames.push(String(input.subagent_type || input.agent || 'general-purpose'));
        }
        stats.tools[toolName] = (stats.tools[toolName] || 0) + 1;

        const skillRead = toolName === 'Read' ? detectSkillRead(input) : null;
        entries.push({
          ts,
          action_id: tu.id || `${obj.uuid}-${idx}`,
          parent_id: null,
          child_ids: [],
          event: 'pre',
          tool: skillRead ? 'SkillRead' : toolName,
          cmd: skillRead ? `${skillRead.plugin}:${skillRead.name}` : buildCmd(toolName, input),
          input: skillRead ? { ...input, skill: skillRead.name, plugin: skillRead.plugin } : input,
          tokens: idx === 0 ? turnTokens : null,
          skillRead,
          attribution,
        });
      });

      if (turnTokens.input || turnTokens.output || turnTokens.cache_read || turnTokens.cache_create) {
        stats.timeline.push({ ts, ...turnTokens, tools: toolNames, skills: skillNames, agents: agentNames });
      }

    } else if (obj.type === 'user') {
      const content = msg.content;

      // Plain string content = direct user prompt (no injected context blocks)
      if (typeof content === 'string') {
        const text = content.trim();
        if (text && !text.startsWith('<')) {
          entries.push({
            ts,
            action_id: obj.uuid || `prompt-${i}`,
            parent_id: null,
            child_ids: [],
            event: 'prompt',
            tool: 'User',
            cmd: text.slice(0, 120),
            input: { message: text },
            tokens: null,
          });
        } else if (!sessionTeamTask && text.includes('<teammate-message')) {
          const m = text.match(/assigned Task #?\d*:?\s*"([^"]+)"/i);
          if (m) sessionTeamTask = m[1];
        }
        continue;
      }

      if (!Array.isArray(content)) continue;

      const toolResults = content.filter(b => b.type === 'tool_result');
      const textBlocks = content.filter(b => b.type === 'text');

      for (const tr of toolResults) {
        entries.push({
          ts,
          action_id: tr.tool_use_id || obj.uuid || '',
          parent_id: null,
          child_ids: [],
          event: 'post',
          tool: '',
          cmd: '',
          input: {},
          tokens: null,
          response: extractToolResultText(tr.content),
        });
      }

      if (!toolResults.length && textBlocks.length) {
        const fullText = textBlocks.map(b => b.text || '').join('\n');
        const injected = detectInjectedSkills(fullText);
        injected.forEach((inj, k) => {
          const idx = inj.name.indexOf(':');
          const plugin = idx > -1 ? inj.name.slice(0, idx) : '(builtin)';
          const skill = idx > -1 ? inj.name.slice(idx + 1) : inj.name;
          entries.push({
            ts,
            action_id: `${obj.uuid || `inj-${i}`}-inj${k}`,
            parent_id: null,
            child_ids: [],
            event: 'command',
            tool: 'SkillInjected',
            cmd: inj.name,
            input: { skill, plugin, raw: inj.raw, source: 'system-reminder' },
            tokens: null,
          });
        });
        // Filter out system-injected context blocks (ide_opened_file, reminders, etc.)
        const userText = textBlocks
          .map(b => b.text || '')
          .filter(t => t.trim() && !t.trim().startsWith('<'))
          .join('\n')
          .trim();
        if (userText) {
          entries.push({
            ts,
            action_id: obj.uuid || `prompt-${i}`,
            parent_id: null,
            child_ids: [],
            event: 'prompt',
            tool: 'User',
            cmd: userText.slice(0, 120),
            input: { message: userText },
            tokens: null,
          });
        }
      }
    }
  }

  stats.agentRole = sessionAgentSetting;
  return {
    entries,
    stats,
    lastLine: lines.length,
    agentSetting: sessionAgentSetting,
    agentName: sessionAgentName,
    teamName: sessionTeamName,
    teamTask: sessionTeamTask,
    attributionSkill: sessionAttributionSkill,
    attributionAgent: sessionAttributionAgent,
    attributionPlugin: sessionAttributionPlugin,
  };
}

function emptyStats(): Stats {
  return {
    tokens: { input: 0, output: 0, cache_read: 0, cache_create: 0 },
    tools: {},
    timeline: [],
    agentRole: '',
  };
}

export function mergeStats(base: Stats, delta: Stats): Stats {
  const tools = { ...base.tools };
  for (const [k, v] of Object.entries(delta.tools)) {
    tools[k] = (tools[k] || 0) + v;
  }
  return {
    tokens: {
      input: base.tokens.input + delta.tokens.input,
      output: base.tokens.output + delta.tokens.output,
      cache_read: base.tokens.cache_read + delta.tokens.cache_read,
      cache_create: base.tokens.cache_create + delta.tokens.cache_create,
    },
    tools,
    timeline: [...base.timeline, ...delta.timeline],
    agentRole: base.agentRole || delta.agentRole,
  };
}
