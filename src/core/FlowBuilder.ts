import type { AppEntry } from './LogParser';

export interface FlowStep {
  index: number;
  ts: string;
  event: 'prompt' | 'command' | 'tool' | 'response';
  tool: string;
  summary: string;
  depth: number;
  attribution?: { skill: string; agent: string; plugin: string } | null;
  skill?: { plugin: string; name: string } | null;
  parentId: string | null;
  actionId: string;
}

function truncate(s: string, max = 120): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

function summarizeInput(tool: string, input: Record<string, unknown>): string {
  if (!input || typeof input !== 'object') return '';
  const t = tool.toLowerCase();
  if (t === 'bash') return truncate(String(input.command ?? input.description ?? ''));
  if (t === 'read' || t === 'edit' || t === 'write') return truncate(String(input.file_path ?? ''));
  if (t === 'grep' || t === 'glob') return truncate(String(input.pattern ?? input.query ?? ''));
  if (t === 'webfetch' || t === 'websearch') return truncate(String(input.url ?? input.query ?? ''));
  if (t === 'task' || t === 'agent') {
    const desc = String(input.description ?? input.subagent_type ?? '');
    return truncate(desc);
  }
  if (t === 'skill') return truncate(String(input.skill ?? input.args ?? ''));
  // Fallback: first string-valued field
  for (const v of Object.values(input)) {
    if (typeof v === 'string') return truncate(v);
  }
  return '';
}

/**
 * Walks parsed AppEntries in order and returns a compact, ordered flow.
 * `depth` is derived from parent_id chain so callers can render an indented tree.
 */
export function buildFlow(entries: AppEntry[]): FlowStep[] {
  // Build depth map by walking parent_id chain.
  const byId = new Map<string, AppEntry>();
  for (const e of entries) byId.set(e.action_id, e);
  const depthCache = new Map<string, number>();
  const depthOf = (id: string | null | undefined, guard = 0): number => {
    if (!id || guard > 64) return 0;
    if (depthCache.has(id)) return depthCache.get(id)!;
    const node = byId.get(id);
    if (!node) return 0;
    const d = node.parent_id ? depthOf(node.parent_id, guard + 1) + 1 : 0;
    depthCache.set(id, d);
    return d;
  };

  const steps: FlowStep[] = [];
  let idx = 0;
  for (const e of entries) {
    // Collapse pre/post pairs into one "tool" step keyed on pre; skip post.
    if (e.event === 'post') continue;
    let event: FlowStep['event'];
    if (e.event === 'prompt') event = 'prompt';
    else if (e.event === 'command') event = 'command';
    else event = 'tool';
    const summary =
      event === 'prompt'
        ? truncate(String((e.input as Record<string, unknown>)?.message ?? ''))
        : event === 'command'
        ? truncate(e.cmd || '')
        : summarizeInput(e.tool, e.input);
    steps.push({
      index: idx++,
      ts: e.ts,
      event,
      tool: e.tool || '',
      summary,
      depth: depthOf(e.parent_id) + (e.parent_id ? 1 : 0),
      attribution: e.attribution ?? null,
      skill: e.skillRead ?? null,
      parentId: e.parent_id,
      actionId: e.action_id,
    });
  }
  return steps;
}
