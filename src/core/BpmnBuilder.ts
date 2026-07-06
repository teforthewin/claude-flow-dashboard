import type { AppEntry } from './LogParser';
import { buildFlow, FlowStep } from './FlowBuilder';

export interface BpmnTask {
  id: string;
  type: 'task';
  name: string;
  start_ts: string;
  end_ts: string;
  duration_ms: number;
  tools: Record<string, number>;
  agents_spawned: string[];
  skills_used: string[];
}

export interface BpmnEvent {
  id: string;
  type: 'startEvent' | 'endEvent';
  name: string;
}

export type BpmnElement = BpmnTask | BpmnEvent;

export interface BpmnFlow {
  id: string;
  sourceRef: string;
  targetRef: string;
}

export interface BpmnProcess {
  processId: string;
  name: string;
  elements: BpmnElement[];
  flows: BpmnFlow[];
}

function truncate(s: string, max = 80): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + '…' : oneLine;
}

function diffMs(a: string, b: string): number {
  if (!a || !b) return 0;
  const d = new Date(b).getTime() - new Date(a).getTime();
  return d > 0 ? d : 0;
}

/**
 * Segments a session's flow into BPMN phases: each top-level (depth 0)
 * prompt or command step opens a new phase; every subsequent step
 * (nested tool calls, sub-agent spawns, responses) belongs to that phase
 * until the next top-level prompt/command starts a new one.
 */
export function buildBpmnPhases(entries: AppEntry[], processName = 'session'): BpmnProcess {
  const steps = buildFlow(entries);
  const phases: FlowStep[][] = [];
  for (const step of steps) {
    const isPhaseStart = step.depth === 0 && (step.event === 'prompt' || step.event === 'command');
    if (isPhaseStart || phases.length === 0) phases.push([]);
    phases[phases.length - 1].push(step);
  }

  const elements: BpmnElement[] = [{ id: 'Start', type: 'startEvent', name: 'Session start' }];
  const flows: BpmnFlow[] = [];
  let prevId = 'Start';

  phases.forEach((phaseSteps, i) => {
    const head = phaseSteps[0];
    const tools: Record<string, number> = {};
    const agents_spawned: string[] = [];
    const skills_used: string[] = [];
    for (const s of phaseSteps) {
      if (s.event === 'tool' && s.tool) tools[s.tool] = (tools[s.tool] || 0) + 1;
      if (s.tool === 'Agent' && s.summary) agents_spawned.push(s.summary);
      if (s.skill) skills_used.push(`${s.skill.plugin}:${s.skill.name}`);
    }
    const id = `Phase_${i + 1}`;
    const startTs = head?.ts || '';
    const endTs = phaseSteps[phaseSteps.length - 1]?.ts || '';
    const task: BpmnTask = {
      id,
      type: 'task',
      name: truncate(head?.summary || head?.tool || head?.event || `Phase ${i + 1}`),
      start_ts: startTs,
      end_ts: endTs,
      duration_ms: diffMs(startTs, endTs),
      tools,
      agents_spawned,
      skills_used,
    };
    elements.push(task);
    flows.push({ id: `Flow_${flows.length + 1}`, sourceRef: prevId, targetRef: id });
    prevId = id;
  });

  elements.push({ id: 'End', type: 'endEvent', name: 'Session end' });
  flows.push({ id: `Flow_${flows.length + 1}`, sourceRef: prevId, targetRef: 'End' });

  return {
    processId: `Process_${processName.replace(/\W+/g, '_').slice(0, 60) || 'session'}`,
    name: processName,
    elements,
    flows,
  };
}
