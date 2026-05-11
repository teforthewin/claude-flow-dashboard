import { createApp, ref, reactive, computed, watch, onMounted, onUnmounted, nextTick, shallowRef } from 'vue';

// ─── Utilities ───────────────────────────────────────────────────────────
function fmtK(n) {
  if (!n) return '0';
  if (n >= 1_000_000) return (Math.round(n / 100_000) / 10) + 'M';
  if (n >= 1000) return (Math.round(n / 100) / 10) + 'k';
  return String(n);
}
function fmtT(ts) { return ts ? ts.slice(11, 19) : ''; }
function fmtCost(n) { return '$' + (n >= 0.01 ? n.toFixed(2) : n.toFixed(4)); }
function fmtCostSmall(n) { return '$' + (n >= 0.001 ? n.toFixed(3) : n.toFixed(4)); }

const CONTAINER_TOOLS = new Set(['Agent', 'Skill', 'Bash']);

// Walk a built tree node up via parentId in nodeMap, returning the chain of
// Agent labels from root → leaf. "main" if no Agent ancestor.
function computeInvokerChain(node, nodeMap) {
  const chain = [];
  let cur = node;
  let safety = 50;
  while (cur && cur.parentId && safety-- > 0) {
    const par = nodeMap.get(cur.parentId);
    if (!par) break;
    if (par.tool === 'Agent') {
      const i = par.input || {};
      const type = i.subagent_type || i.agent || 'general-purpose';
      const desc = i.description ? ` (${String(i.description).slice(0, 30)})` : '';
      chain.unshift(`${type}${desc}`);
    }
    cur = par;
  }
  if (!chain.length) chain.push('main');
  return chain;
}

function isSkillEvent(tool) {
  return tool === 'Skill' || tool === 'SkillRead' || tool === 'SkillInjected' || tool === 'SkillListing';
}

// Group flat skill names ("plugin:skill" or "skill") into [{plugin, items:[...]}]
function groupSkills(skills) {
  if (!Array.isArray(skills) || !skills.length) return [];
  const map = new Map();
  for (const s of skills) {
    const idx = s.indexOf(':');
    const plugin = idx > -1 ? s.slice(0, idx) : '(builtin)';
    const name = idx > -1 ? s.slice(idx + 1) : s;
    if (!map.has(plugin)) map.set(plugin, []);
    map.get(plugin).push(name);
  }
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([plugin, items]) => ({ plugin, items: items.sort() }));
}

function getLabel(node) {
  if (node.cmd) return node.cmd;
  const i = node.input || {};
  switch (node.tool) {
    case 'Agent':       return `${i.agent || i.subagent_type || 'general-purpose'}${i.name ? ' ['+i.name+']' : ''}`;
    case 'Skill':       return `${i.skill||''}${i.args?' '+i.args:''}`;
    case 'SendMessage': return `→ ${i.to||''}: ${(i.message||'').slice(0,80)}`;
    case 'TaskCreate':  return i.title || '';
    case 'TaskUpdate':  return `${i.id||''} → ${i.status||''}`;
    case 'Read': case 'Glob': case 'Grep':
      return (i.file_path||i.path||i.pattern||'').split('/').slice(-2).join('/');
    case 'WebFetch': return String(i.url||'').replace(/^https?:\/\//,'').slice(0,80);
    case 'WebSearch': return String(i.query||'').slice(0,80);
    case 'Bash': return i.description || (i.command||'').slice(0,80) || '';
    case 'Edit': case 'Write': return (i.file_path||'').split('/').slice(-2).join('/');
    case 'Command': return `${i.command||''} ${i.args||''}`.trim();
    case 'User': return (i.message||'').slice(0,120);
    case 'AgentSetting': return String(i.skill||'');
    case 'SkillListing': return `${i.skillCount ?? 0} skills loaded`;
    case 'SkillRead': return `${i.plugin||''}:${i.skill||''}`;
    case 'SkillInjected': return String(i.skill || node.cmd || '');
    default:
      if (node.tool?.startsWith('mcp__')) return node.tool.replace(/^mcp__[^_]+__/, '');
      return '';
  }
}

function getDescription(node) {
  const i = node.input || {};
  if (node.tool === 'Agent' && i.description) return i.description;
  if (node.tool === 'Skill' && i.args) return i.args;
  if (node.tool === 'SendMessage' && i.message) return String(i.message).slice(0, 200);
  if (node.tool === 'Bash' && i.command) return String(i.command).slice(0, 200);
  if (node.tool === 'Command' && i.args) return i.args;
  if (node.tool === 'WebFetch' && i.prompt) return String(i.prompt).slice(0, 200);
  return '';
}

function extractContentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(b => b && (b.type === 'text' || typeof b === 'string'))
      .map(b => typeof b === 'string' ? b : (b.text || ''))
      .join('\n');
  }
  return String(content);
}

function formatResponse(r) {
  if (!r || r === '') return '';
  if (typeof r === 'object') {
    if (r.stdout != null || r.stderr != null) {
      const parts = [];
      if (r.exit_code != null && r.exit_code !== 0) parts.push('exit: ' + r.exit_code);
      if (r.stdout) parts.push(String(r.stdout).slice(0, 500));
      if (r.stderr) parts.push('stderr: ' + String(r.stderr).slice(0, 200));
      return parts.join('\n');
    }
    if (r.files) return `${r.count||0} files: ${Array.isArray(r.files)?r.files.join(', '):r.files}`;
    if (r.matches) return `${r.num_files||0} files matched\n${r.matches}`;
    if (r.content) return extractContentText(r.content).slice(0, 2000);
    return JSON.stringify(r, null, 2).slice(0, 600);
  }
  return String(r).slice(0, 600);
}

function leafTagClass(tool) {
  if (!tool) return 'ltag-default';
  if (tool.startsWith('mcp__')) return 'ltag-mcp';
  const m = { Bash:'ltag-bash', Read:'ltag-read', Glob:'ltag-glob', Grep:'ltag-grep',
              Edit:'ltag-edit', Write:'ltag-write', Skill:'ltag-skill',
              SendMessage:'ltag-sendmessage', TaskCreate:'ltag-taskcreate',
              TaskUpdate:'ltag-taskupdate', Command:'ltag-command', User:'ltag-user',
              AgentSetting:'ltag-agentsetting', SkillListing:'ltag-skilllisting',
              SkillRead:'ltag-skill', SkillInjected:'ltag-skill' };
  return m[tool] || 'ltag-default';
}

// ─── Tree Builder ────────────────────────────────────────────────────────
function buildTree(entries) {
  const root = { id:'root', tool:'Claude', children:[], status:'root',
                 input:{}, ts:entries[0]?.ts||'', response:null, postTs:null, cmd:'', tokens:null };
  const nodeMap = new Map();
  const hasParentIds = entries.some(e => e.parent_id);
  if (hasParentIds) _buildById(entries, root, nodeMap);
  else _buildHeuristic(entries, root, nodeMap);
  // Annotate skill-related nodes with the full invoker chain (root → leaf).
  for (const node of nodeMap.values()) {
    if (isSkillEvent(node.tool)) node.invokerChain = computeInvokerChain(node, nodeMap);
  }
  return { root, nodeMap };
}

function _buildById(entries, root, nodeMap) {
  nodeMap.set('root', root); nodeMap.set(null, root); nodeMap.set(undefined, root);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.event !== 'pre' && e.event !== 'command' && e.event !== 'prompt') continue;
    const node = { id:e.action_id||`i${i}`, tool:e.tool, input:e.input||{}, ts:e.ts,
                   cmd:e.cmd||'', tokens:e.tokens||null,
                   status:CONTAINER_TOOLS.has(e.tool)?'active':'done',
                   children:[], response:null, postTs:null, parallel:false, parentId:e.parent_id||null };
    nodeMap.set(node.id, node);
    const par = nodeMap.get(e.parent_id) || root;
    node.parentId = par.id;
    if (e.tool === 'Agent') {
      const sib = par.children.find(c => c.tool === 'Agent' && c.status === 'active');
      if (sib) { node.parallel = true;
        par.children.filter(c => c.tool==='Agent'&&(c.status==='active'||c.parallel)).forEach(c => c.parallel=true); }
    }
    par.children.push(node);
  }
  for (const e of entries) {
    if (e.event !== 'post') continue;
    const node = nodeMap.get(e.action_id);
    if (!node) continue;
    node.status = 'done'; node.response = e.response ?? ''; node.postTs = e.ts;
    if (e.tokens) node.tokens = e.tokens;
  }
}

function _buildHeuristic(entries, root, nodeMap) {
  nodeMap.set('root', root);
  const stack = [root], openAgents = [];
  const agentKey = inp => `${inp?.agent||inp?.subagent_type||''}::${inp?.name||''}`;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.event === 'post') {
      if (e.action_id && nodeMap.has(e.action_id)) {
        const node = nodeMap.get(e.action_id);
        node.status='done'; node.response=e.response??''; node.postTs=e.ts;
        if (e.tokens) node.tokens=e.tokens;
        if (node.tool==='Agent') {
          const mi = openAgents.indexOf(node); if (mi!==-1) openAgents.splice(mi,1);
          const si = stack.indexOf(node); if (si!==-1) stack.splice(si,1);
        }
        continue;
      }
      if (e.tool === 'Agent') {
        const key = agentKey(e.input);
        let mi = -1;
        for (let j = openAgents.length-1; j >= 0; j--) { if (agentKey(openAgents[j].input)===key) { mi=j; break; } }
        if (mi===-1 && openAgents.length) mi = openAgents.length-1;
        if (mi!==-1) {
          const n = openAgents[mi]; n.status='done'; n.response=e.response??''; n.postTs=e.ts;
          if (e.tokens) n.tokens=e.tokens; openAgents.splice(mi,1);
          const si = stack.indexOf(n); if (si!==-1) stack.splice(si,1);
        }
      } else {
        for (let j = stack.length-1; j >= 0; j--) {
          let found = false;
          for (let k = stack[j].children.length-1; k >= 0; k--) {
            const c = stack[j].children[k];
            if (c.tool===e.tool && c.status==='pending') {
              c.status='done'; c.response=e.response??''; c.postTs=e.ts;
              if (e.tokens) c.tokens=e.tokens; found=true; break;
            }
          }
          if (found) break;
        }
      }
      continue;
    }
    if (e.event === 'command' || e.event === 'prompt') {
      const n = { id:e.action_id||`i${i}`, tool:e.tool||'Command', input:e.input||{}, ts:e.ts, cmd:e.cmd||'',
                  tokens:e.tokens||null, status:'done', children:[], response:null, postTs:null,
                  parallel:false, parentId:root.id };
      nodeMap.set(n.id, n); root.children.push(n); continue;
    }
    if (e.tool === 'Agent') {
      let pi = stack.length-1;
      const eMs = new Date(e.ts).getTime();
      while (pi > 0 && stack[pi].tool === 'Agent' && stack[pi].status === 'active') {
        const gap = (eMs - new Date(stack[pi].ts).getTime()) / 1000;
        if (gap < 30) pi--;
        else break;
      }
      const par = stack[pi];
      const n = { id:e.action_id||`i${i}`, tool:'Agent', input:e.input||{}, ts:e.ts, cmd:e.cmd||'',
                  tokens:e.tokens||null, status:'active', children:[], response:null, postTs:null,
                  parallel:false, parentId:par.id };
      const sib = par.children.find(c=>c.tool==='Agent'&&c.status==='active');
      if (sib) { n.parallel=true; par.children.filter(c=>c.tool==='Agent'&&(c.status==='active'||c.parallel)).forEach(c=>c.parallel=true); }
      nodeMap.set(n.id, n); par.children.push(n); openAgents.push(n); stack.push(n);
    } else {
      const par = stack[stack.length-1];
      const np = e.tool==='Skill'||e.tool==='SendMessage';
      const n = { id:e.action_id||`i${i}`, tool:e.tool, input:e.input||{}, ts:e.ts, cmd:e.cmd||'',
                  tokens:e.tokens||null, status:np?'pending':'done',
                  children:[], response:null, postTs:null, parallel:false, parentId:par.id };
      nodeMap.set(n.id, n); par.children.push(n);
    }
  }
}

// ─── Step Grouping ───────────────────────────────────────────────────────
const SOLO_TOOLS = new Set(['User', 'Command', 'SkillListing', 'AgentSetting', 'SkillInjected']);
const PARALLEL_GAP_MS = 10000;

function isOrch(node) {
  if (node.tool === 'Agent') return true;
  // Skill is orch only when it actually nested operations
  if (node.tool === 'Skill' && node.children?.length) return true;
  return false;
}

function groupIntoSteps(node) {
  const kids = node?.children || [];
  const steps = [];
  let buf = [];
  const flushSeq = () => { if (buf.length) { steps.push({ kind:'seq', nodes:buf }); buf = []; } };
  for (let i = 0; i < kids.length; ) {
    const c = kids[i];
    if (SOLO_TOOLS.has(c.tool)) { flushSeq(); steps.push({ kind:'solo', nodes:[c] }); i++; continue; }
    if (!isOrch(c)) { buf.push(c); i++; continue; }
    flushSeq();
    // Cluster contiguous Agent siblings as parallel when they overlap in time
    // or when buildTree flagged them, or when they fire within PARALLEL_GAP_MS.
    if (c.tool === 'Agent') {
      const grp = [c];
      let j = i + 1;
      while (j < kids.length && kids[j].tool === 'Agent') {
        const prev = grp[grp.length - 1];
        const gap = (new Date(kids[j].ts).getTime() - new Date(prev.ts).getTime());
        const overlap = prev.postTs && new Date(kids[j].ts).getTime() < new Date(prev.postTs).getTime();
        if (kids[j].parallel || prev.parallel || overlap || (Number.isFinite(gap) && gap >= 0 && gap < PARALLEL_GAP_MS)) {
          grp.push(kids[j]); j++;
        } else break;
      }
      if (grp.length > 1) { steps.push({ kind:'parallel', nodes: grp }); i = j; continue; }
    }
    // Single agent or skill orch step
    steps.push({ kind:'orch', nodes: [c] });
    i++;
  }
  flushSeq();
  return steps;
}

function aggregateStep(nodes) {
  let inT = 0, outT = 0, dur = 0;
  const byTool = {};
  for (const n of nodes) {
    byTool[n.tool] = (byTool[n.tool]||0) + 1;
    const t = n.tokens;
    if (t) {
      inT += (t.input||0) + (t.cache_read||0) + (t.cache_create||0) + (t.cache_write||0);
      outT += (t.output||0);
      dur += (t.duration_ms||0);
    }
  }
  const firstTs = nodes[0]?.ts;
  const lastTs = nodes[nodes.length-1]?.postTs || nodes[nodes.length-1]?.ts;
  let span = 0;
  if (firstTs && lastTs) {
    const ms = new Date(lastTs).getTime() - new Date(firstTs).getTime();
    if (ms > 0) span = ms;
  }
  return {
    inT, outT, dur, span,
    tools: Object.entries(byTool).map(([tool,count]) => ({ tool, count, tag: leafTagClass(tool) })),
  };
}

function fmtDur(ms) {
  if (!ms) return '';
  if (ms < 1000) return ms + 'ms';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + 's';
  const m = Math.floor(s / 60);
  return `${m}m${Math.round(s % 60)}s`;
}

function resolveAgentSubtree(node, descMap, treeMap) {
  if (!descMap || !treeMap) return null;
  const desc = String(node.input?.description || '').trim();
  if (!desc) return null;
  const sid = descMap.get(desc);
  return sid ? (treeMap.get(sid) || null) : null;
}

// ─── Mermaid diagram emitter ─────────────────────────────────────────────
// Recursive aggregate of all leaf tokens + child counts under a node
function aggregateRecursive(node) {
  let inT = 0, outT = 0, dur = 0, count = 0;
  function walk(n) {
    const t = n.tokens;
    if (t) {
      inT += (t.input||0) + (t.cache_read||0) + (t.cache_create||0) + (t.cache_write||0);
      outT += (t.output||0);
      dur += (t.duration_ms||0);
    }
    count++;
    for (const c of (n.children || [])) walk(c);
  }
  for (const c of (node.children || [])) walk(c);
  return { inT, outT, dur, count };
}

function treeToMermaid(root, opts = {}) {
  const { maxDepth = 3, direction = 'TD', sessionDescMap = null, sessionTreeMap = null } = opts;
  const lines = [`flowchart ${direction}`];
  const clicks = [];
  const meta = {};
  let counter = 0;
  const nextId = () => `n${counter++}`;

  // Mermaid-safe label
  const esc = (s) => String(s || '')
    .replace(/[\n\r]+/g, ' ')
    .replace(/["`]/g, "'")
    .replace(/[<>]/g, '')
    .replace(/[\[\](){}]/g, '')
    .slice(0, 70) || '—';

  function agentLabel(n) {
    const t = n.input?.agent || n.input?.subagent_type || 'agent';
    const d = n.input?.description || '';
    return d ? `${t}: ${d}` : t;
  }

  function statsLine(agg) {
    const bits = [];
    if (agg.count) bits.push(`${agg.count} ops`);
    if (agg.dur)   bits.push(fmtDur(agg.dur));
    if (agg.inT)   bits.push(`↑${fmtK(agg.inT)}`);
    if (agg.outT)  bits.push(`↓${fmtK(agg.outT)}`);
    return bits.join(' · ');
  }

  function childSessionId(n) {
    if (!sessionDescMap) return null;
    const desc = String(n.input?.description || '').trim();
    return desc ? (sessionDescMap.get(desc) || null) : null;
  }

  // Returns array of "anchors" {entry, exit} for chaining; subgraph anchors point to inner nodes.
  function emit(node, depth, indent = '  ') {
    const steps = groupIntoSteps(node);
    const anchors = [];

    for (const s of steps) {
      if (s.kind === 'solo') {
        const id = nextId();
        const n = s.nodes[0];
        const lbl = n.tool === 'User' ? `User prompt: ${getLabel(n)}` : `${n.tool}: ${getLabel(n)}`;
        lines.push(`${indent}${id}(["${esc(lbl)}"]):::solo`);
        meta[id] = {
          kind: 'solo', tool: n.tool, ts: n.ts,
          title: n.tool === 'User' ? 'User prompt' : n.tool,
          fullText: n.cmd || getLabel(n) || (n.input?.message || ''),
        };
        anchors.push({ entry: id, exit: id });
      } else if (s.kind === 'seq') {
        const id = nextId();
        const agg = aggregateStep(s.nodes);
        const tools = agg.tools.map(t => `${t.tool}${t.count > 1 ? '×' + t.count : ''}`).join(' · ');
        const stats = [];
        if (agg.span) stats.push(fmtDur(agg.span));
        if (agg.inT)  stats.push(`↑${fmtK(agg.inT)}`);
        if (agg.outT) stats.push(`↓${fmtK(agg.outT)}`);
        const labelParts = [tools];
        if (stats.length) labelParts.push(stats.join(' · '));
        lines.push(`${indent}${id}["${esc(labelParts[0])}${labelParts[1] ? '<br/><i>'+esc(labelParts[1])+'</i>' : ''}"]:::seq`);
        meta[id] = {
          kind: 'seq', title: 'Sequential operations',
          tsStart: s.nodes[0]?.ts, tsEnd: s.nodes[s.nodes.length-1]?.postTs || s.nodes[s.nodes.length-1]?.ts,
          duration: agg.span, inT: agg.inT, outT: agg.outT,
          ops: s.nodes.map(n => ({ tool: n.tool, label: getLabel(n) })),
        };
        anchors.push({ entry: id, exit: id });
      } else if (s.kind === 'orch') {
        const n = s.nodes[0];
        const lbl = `${n.tool}: ${getLabel(n)}`;
        const sub = resolveAgentSubtree(n, sessionDescMap, sessionTreeMap) || (n.children?.length ? n : null);
        const sid = childSessionId(n);
        if (depth < maxDepth && sub) {
          const sgId = nextId();
          const agg = aggregateRecursive(sub);
          const stats = statsLine(agg);
          const sgLabel = stats ? `${esc(lbl)}<br/><i>${esc(stats)}</i>` : esc(lbl);
          lines.push(`${indent}subgraph ${sgId} ["${sgLabel}"]`);
          const innerAnchors = emit(sub, depth + 1, indent + '  ');
          lines.push(`${indent}end`);
          lines.push(`${indent}class ${sgId} sgOrch`);
          meta[sgId] = {
            kind: 'orch', title: lbl, ts: n.ts, postTs: n.postTs,
            description: getDescription(n), agg, sessionId: sid,
            response: formatResponse(n.response).slice(0, 600),
          };
          if (sid) clicks.push(`click ${sgId} call __loomNavigate("${sid}") "Open sub-agent session"`);
          if (innerAnchors.length) {
            anchors.push({ entry: innerAnchors[0].entry, exit: innerAnchors[innerAnchors.length - 1].exit });
          } else {
            const empty = nextId();
            lines.push(`${indent}${empty}["(no ops)"]:::empty`);
            anchors.push({ entry: empty, exit: empty });
          }
        } else {
          const id = nextId();
          const agg = sub ? aggregateRecursive(sub) : { count: 0, dur: 0, inT: 0, outT: 0 };
          const stats = statsLine(agg);
          const collapsed = stats ? `<br/><i>${esc(stats)} collapsed</i>` : '';
          lines.push(`${indent}${id}["${esc(lbl)}${collapsed}"]:::orch`);
          meta[id] = {
            kind: 'orch-collapsed', title: lbl, ts: n.ts, postTs: n.postTs,
            description: getDescription(n), agg, sessionId: sid,
            response: formatResponse(n.response).slice(0, 600),
          };
          if (sid) clicks.push(`click ${id} call __loomNavigate("${sid}") "Open sub-agent session"`);
          anchors.push({ entry: id, exit: id });
        }
      } else if (s.kind === 'parallel') {
        const fork = nextId();
        const join = nextId();
        lines.push(`${indent}${fork}{{"+"}}:::fork`);
        lines.push(`${indent}${join}{{"+"}}:::fork`);
        for (const n of s.nodes) {
          const lbl = agentLabel(n);
          const sub = resolveAgentSubtree(n, sessionDescMap, sessionTreeMap) || (n.children?.length ? n : null);
          const sid = childSessionId(n);
          if (depth < maxDepth && sub) {
            const sgId = nextId();
            const agg = aggregateRecursive(sub);
            const stats = statsLine(agg);
            const sgLabel = stats ? `${esc(lbl)}<br/><i>${esc(stats)}</i>` : esc(lbl);
            lines.push(`${indent}subgraph ${sgId} ["${sgLabel}"]`);
            const innerAnchors = emit(sub, depth + 1, indent + '  ');
            lines.push(`${indent}end`);
            lines.push(`${indent}class ${sgId} sgAgent`);
            meta[sgId] = {
              kind: 'parallel-agent', title: lbl, ts: n.ts, postTs: n.postTs,
              description: getDescription(n), agg, sessionId: sid,
              response: formatResponse(n.response).slice(0, 600),
            };
            if (sid) clicks.push(`click ${sgId} call __loomNavigate("${sid}") "Open sub-agent session"`);
            if (innerAnchors.length) {
              lines.push(`${indent}${fork} --> ${innerAnchors[0].entry}`);
              lines.push(`${indent}${innerAnchors[innerAnchors.length - 1].exit} --> ${join}`);
            } else {
              const empty = nextId();
              lines.push(`${indent}  ${empty}["(no ops)"]:::empty`);
              lines.push(`${indent}${fork} --> ${empty}`);
              lines.push(`${indent}${empty} --> ${join}`);
            }
          } else {
            const id = nextId();
            const agg = sub ? aggregateRecursive(sub) : { count: 0, dur: 0, inT: 0, outT: 0 };
            const stats = statsLine(agg);
            const collapsed = stats ? `<br/><i>${esc(stats)} collapsed</i>` : '';
            lines.push(`${indent}${id}["${esc(lbl)}${collapsed}"]:::orch`);
            meta[id] = {
              kind: 'parallel-agent-collapsed', title: lbl, ts: n.ts, postTs: n.postTs,
              description: getDescription(n), agg, sessionId: sid,
              response: formatResponse(n.response).slice(0, 600),
            };
            if (sid) clicks.push(`click ${id} call __loomNavigate("${sid}") "Open sub-agent session"`);
            lines.push(`${indent}${fork} --> ${id}`);
            lines.push(`${indent}${id} --> ${join}`);
          }
        }
        anchors.push({ entry: fork, exit: join });
      }
    }
    // chain consecutive anchors
    for (let i = 0; i < anchors.length - 1; i++) {
      lines.push(`${indent}${anchors[i].exit} --> ${anchors[i + 1].entry}`);
    }
    return anchors;
  }

  const startId = nextId();
  const endId = nextId();
  lines.push(`  ${startId}((▶)):::startNode`);
  const anchors = emit(root, 0);
  lines.push(`  ${endId}((■)):::endNode`);
  if (anchors.length) {
    lines.push(`  ${startId} --> ${anchors[0].entry}`);
    lines.push(`  ${anchors[anchors.length - 1].exit} --> ${endId}`);
  } else {
    lines.push(`  ${startId} --> ${endId}`);
  }

  // class definitions
  lines.push('  classDef startNode fill:#dcfce7,stroke:#16a34a,color:#166534,stroke-width:2px');
  lines.push('  classDef endNode fill:#f1f5f9,stroke:#94a3b8,color:#475569,stroke-width:2px');
  lines.push('  classDef solo fill:#eff6ff,stroke:#1d4ed8,color:#1e3a8a');
  lines.push('  classDef seq fill:#f8fafc,stroke:#94a3b8,color:#334155');
  lines.push('  classDef orch fill:#eff6ff,stroke:#2563eb,color:#1e3a8a,stroke-width:1.5px');
  lines.push('  classDef fork fill:#fef3c7,stroke:#92400e,color:#92400e,stroke-width:2px');
  lines.push('  classDef empty fill:#fafafa,stroke:#cbd5e1,color:#94a3b8');
  lines.push('  classDef sgOrch fill:#eff6ff,stroke:#2563eb,color:#1e3a8a');
  lines.push('  classDef sgAgent fill:#f5f3ff,stroke:#7c3aed,color:#5b21b6');

  // Clickable nodes (sub-agent navigation)
  for (const c of clicks) lines.push('  ' + c);

  return { source: lines.join('\n'), meta };
}

// ─── Token Index (binary search) ─────────────────────────────────────────
function buildTokenIndex(entries, timeline) {
  const idx = new Map();
  if (!timeline?.length) return idx;
  const tl = timeline.filter(m=>m.ts).map(m=>({...m, _ms:new Date(m.ts).getTime()})).sort((a,b)=>a._ms-b._ms);
  if (!tl.length) return idx;
  function closest(targetMs, filterFn) {
    let lo=0, hi=tl.length-1, best=null, bestDiff=Infinity;
    while (lo<=hi) { const mid=(lo+hi)>>1; if (tl[mid]._ms<targetMs) lo=mid+1; else hi=mid-1; }
    const start=Math.max(0,lo-10), end=Math.min(tl.length-1,lo+10);
    for (let i=start; i<=end; i++) {
      const diff=Math.abs(tl[i]._ms-targetMs);
      if (diff<bestDiff && (!filterFn || filterFn(tl[i]))) { bestDiff=diff; best=tl[i]; }
    }
    return bestDiff<=10000 ? best : null;
  }
  for (let i=0; i<entries.length; i++) {
    const e=entries[i];
    if (e.event!=='pre'||!e.ts) continue;
    const ms = new Date(e.ts).getTime();
    let m = closest(ms, t=>t.tools?.includes(e.tool));
    if (!m) m = closest(ms, null);
    if (m) idx.set(i, m);
  }
  return idx;
}

// ─── FlowNode Component ─────────────────────────────────────────────────
const FlowNode = {
  name: 'FlowNode',
  props: { node: Object, tokenIndex: Object, depth: { type: Number, default: 0 }, expandedSet: Object },
  emits: ['toggle'],
  setup(props, { emit }) {
    const respOpen = ref(false);
    const hasKids = computed(() => props.node.children?.length > 0);
    const isExpanded = computed(() => props.expandedSet?.has(props.node.id));
    const isAgent = computed(() => props.node.tool === 'Agent');
    const isSkill = computed(() => props.node.tool === 'Skill');
    const isContainer = computed(() => isAgent.value || isSkill.value);

    const tok = computed(() => {
      const t = props.node.tokens;
      if (t && (t.input||t.output||t.cache_read||t.cache_create||t.cache_write||t.duration_ms)) return t;
      return props.tokenIndex?.get(props.node.id) || null;
    });
    const totalIn = computed(() => tok.value ? (tok.value.input||0)+(tok.value.cache_read||0)+(tok.value.cache_write||0)+(tok.value.cache_create||0) : 0);
    const totalOut = computed(() => tok.value?.output||0);
    const hasTok = computed(() => tok.value && (totalIn.value || totalOut.value));

    const label = computed(() => getLabel(props.node));
    const desc = computed(() => getDescription(props.node));
    const resp = computed(() => formatResponse(props.node.response));
    const tagClass = computed(() => leafTagClass(props.node.tool));
    const answerExcerpt = computed(() => {
      const r = props.node.response;
      if (!r || typeof r !== 'object' || !r.content) return '';
      return extractContentText(r.content).slice(0, 300);
    });

    function toggle() { if (hasKids.value) emit('toggle', props.node.id); }
    function goParent() {
      if (props.node.parentId) {
        const el = document.getElementById('node-'+props.node.parentId);
        if (el) { el.scrollIntoView({behavior:'smooth',block:'nearest'});
          el.style.outline='2px solid var(--agent)'; setTimeout(()=>el.style.outline='',1200); }
      }
    }

    const childGroups = computed(() => {
      const kids = props.node.children || [];
      if (!kids.length) return [];
      const step1 = []; let pb = [];
      for (const ch of kids) {
        if (ch.parallel) pb.push(ch);
        else { if (pb.length) { step1.push({type:'parallel',nodes:pb}); pb=[]; } step1.push({type:'single',node:ch}); }
      }
      if (pb.length) step1.push({type:'parallel',nodes:pb});
      const groups = []; let cb = [];
      function flush() {
        if (!cb.length) return;
        if (cb.length===1) groups.push({type:'single',nodes:[cb[0]]});
        else groups.push({type:'cmdgroup',nodes:[...cb]});
        cb = [];
      }
      for (const item of step1) {
        if (item.type==='single' && item.node.tool!=='Agent' && item.node.tool!=='Skill') cb.push(item.node);
        else { flush(); groups.push(item.node ? {type:item.type, nodes:[item.node]} : item); }
      }
      flush();
      return groups;
    });

    const collapsedGroups = ref(new Set());
    function toggleGroup(gid) {
      const s = new Set(collapsedGroups.value);
      if (s.has(gid)) s.delete(gid); else s.add(gid);
      collapsedGroups.value = s;
    }

    function cmdSummary(nodes) {
      const counts = {}; let ti = 0;
      for (const n of nodes) {
        counts[n.tool] = (counts[n.tool]||0)+1;
        const t = n.tokens; if (t) ti += (t.input||0)+(t.cache_read||0)+(t.cache_create||0)+(t.cache_write||0);
      }
      return { tools: Object.entries(counts).map(([t,c])=>({tool:t,count:c,tag:leafTagClass(t)})), totalIn: ti };
    }

    const injOpen = ref(false);
    function toggleInj(e) { if (e) e.stopPropagation(); injOpen.value = !injOpen.value; }
    const injFields = computed(() => {
      const inp = props.node?.input || {};
      const order = ['subagent_type', 'agent', 'description', 'model', 'team_name', 'isolation', 'mode', 'name', 'run_in_background'];
      const out = [];
      for (const k of order) {
        if (inp[k] != null && inp[k] !== '') out.push({ key: k, value: String(inp[k]), long: false });
      }
      for (const k of Object.keys(inp)) {
        if (order.includes(k) || k === 'prompt') continue;
        const v = inp[k];
        if (v == null || v === '') continue;
        const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
        out.push({ key: k, value: s, long: s.length > 120 || s.includes('\n') });
      }
      if (inp.prompt) out.push({ key: 'prompt', value: String(inp.prompt), long: true });
      return out;
    });

    return { respOpen, hasKids, isExpanded, isAgent, isSkill, isContainer,
             tok, totalIn, totalOut, hasTok, label, desc, resp, tagClass, answerExcerpt,
             toggle, goParent, fmtK, fmtT,
             childGroups, collapsedGroups, toggleGroup, cmdSummary,
             injOpen, toggleInj, injFields };
  },
  template: `
    <div :id="'node-'+node.id">

      <!-- ═══ AGENT NODE — prominent container ═══ -->
      <div v-if="isAgent" class="n-agent">
        <div class="n-agent__hdr" @click="toggle">
          <div class="n-agent__icon">A</div>
          <span class="n-agent__title">{{ label }}</span>
          <span class="n-agent__desc" v-if="desc">{{ desc }}</span>
          <div class="n-agent__meta">
            <button v-if="injFields.length" class="sa-inj-btn" @click.stop="toggleInj($event)"
                    :title="injOpen ? 'Hide spawn payload' : 'Show everything injected to this sub-agent'">
              {{ injOpen ? '&#x25BC;' : '&#x25B6;' }} payload
            </button>
            <span v-if="hasTok" class="n-agent__tokens">
              <span class="t-in">&uarr;{{ fmtK(totalIn) }}</span>
              <span class="t-out">&darr;{{ fmtK(totalOut) }}</span>
            </span>
            <span v-if="node.status==='active'" class="n-agent__status n-agent__status--active">RUNNING</span>
            <span class="n-agent__toggle" v-if="hasKids">{{ isExpanded ? '▼' : '▶' }} {{ node.children.length }}</span>
          </div>
        </div>
        <div v-if="injOpen && injFields.length" class="sa-inj" style="margin:0 12px 8px" @click.stop>
          <div class="sa-inj__hdr">Injected to sub-agent (Agent tool input)</div>
          <div v-for="f in injFields" :key="f.key" class="sa-inj__field">
            <div class="sa-inj__key">{{ f.key }}</div>
            <div v-if="f.long" class="sa-inj__val sa-inj__val--long"><pre>{{ f.value }}</pre></div>
            <div v-else class="sa-inj__val">{{ f.value }}</div>
          </div>
        </div>
        <div v-if="answerExcerpt" class="n-agent__answer" @click.stop="respOpen=!respOpen">
          <div class="n-agent__answer-hdr">
            <span class="n-agent__answer-icon">&#x1F4AC;</span>
            <span class="n-agent__answer-label">Answer</span>
            <span style="font-size:9px;color:var(--text-3);margin-left:auto">{{ respOpen ? '▼ full' : '▶ full' }}</span>
          </div>
          <div class="n-agent__answer-text">{{ respOpen ? resp : answerExcerpt + (answerExcerpt.length >= 300 ? '...' : '') }}</div>
        </div>
        <div v-else-if="resp" style="padding:4px 12px 6px;border-top:1px solid var(--agent-bdr);font-size:10px">
          <button style="background:none;border:none;font-size:10px;color:var(--text-3);cursor:pointer;font-family:inherit"
                  @click.stop="respOpen=!respOpen">{{ respOpen ? '▼' : '▶' }} response</button>
          <pre v-if="respOpen" class="n-leaf__resp" style="margin-left:0;margin-top:4px">{{ resp }}</pre>
        </div>
        <div class="n-agent__children" v-if="isExpanded && hasKids">
          <template v-for="(g,gi) in childGroups" :key="gi">
            <div v-if="g.type==='parallel'" class="n-parallel">
              <div class="n-parallel__hdr">{{ g.nodes.length }} parallel agents</div>
              <div class="n-parallel__cols">
                <div class="n-parallel__col" v-for="c in g.nodes" :key="c.id">
                  <flow-node :node="c" :token-index="tokenIndex" :depth="depth+1" :expanded-set="expandedSet" @toggle="$emit('toggle',$event)" />
                </div>
              </div>
            </div>
            <div v-else-if="g.type==='cmdgroup'" class="n-cmdgroup">
              <div class="n-cmdgroup__hdr" @click="toggleGroup(g.nodes[0].id)">
                <span class="n-cmdgroup__count">{{ g.nodes.length }} operations</span>
                <div class="n-cmdgroup__tools">
                  <span v-for="t in cmdSummary(g.nodes).tools" :key="t.tool" :class="['n-cmdgroup__pill', t.tag]">
                    {{ t.tool }}{{ t.count > 1 ? ' ×'+t.count : '' }}
                  </span>
                </div>
                <span class="n-cmdgroup__tokens" v-if="cmdSummary(g.nodes).totalIn">
                  <span class="t-in">&uarr;{{ fmtK(cmdSummary(g.nodes).totalIn) }}</span>
                </span>
                <span class="n-cmdgroup__chev">{{ collapsedGroups.has(g.nodes[0].id) ? '▶' : '▼' }}</span>
              </div>
              <div class="n-cmdgroup__body" v-if="!collapsedGroups.has(g.nodes[0].id)">
                <flow-node v-for="c in g.nodes" :key="c.id" :node="c" :token-index="tokenIndex"
                           :depth="depth+1" :expanded-set="expandedSet" @toggle="$emit('toggle',$event)" />
              </div>
            </div>
            <flow-node v-else v-for="c in g.nodes" :key="c.id" :node="c" :token-index="tokenIndex"
                       :depth="depth+1" :expanded-set="expandedSet" @toggle="$emit('toggle',$event)" />
          </template>
        </div>
      </div>

      <!-- ═══ SKILL NODE — similar to agent but purple ═══ -->
      <div v-else-if="isSkill" class="n-skill">
        <div class="n-skill__hdr" @click="toggle">
          <div class="n-skill__icon">S</div>
          <span style="font-weight:600;font-size:12px;color:var(--skill)">{{ label }}</span>
          <span v-if="desc" style="font-size:11px;color:var(--text-2);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ desc }}</span>
          <span v-if="hasTok" class="n-agent__tokens">
            <span class="t-in">&uarr;{{ fmtK(totalIn) }}</span> <span class="t-out">&darr;{{ fmtK(totalOut) }}</span>
          </span>
          <span v-if="node.status==='active'" class="n-agent__status n-agent__status--active">RUNNING</span>
          <span v-if="node.status==='pending'" style="font-size:9px;color:var(--text-3)">pending</span>
          <span class="n-agent__toggle" v-if="hasKids">{{ isExpanded ? '▼' : '▶' }} {{ node.children.length }}</span>
        </div>
        <div v-if="answerExcerpt" class="n-agent__answer" style="border-color:#ddd6fe" @click.stop="respOpen=!respOpen">
          <div class="n-agent__answer-hdr">
            <span class="n-agent__answer-icon">&#x1F4AC;</span>
            <span class="n-agent__answer-label">Answer</span>
            <span style="font-size:9px;color:var(--text-3);margin-left:auto">{{ respOpen ? '▼ full' : '▶ full' }}</span>
          </div>
          <div class="n-agent__answer-text">{{ respOpen ? resp : answerExcerpt + (answerExcerpt.length >= 300 ? '...' : '') }}</div>
        </div>
        <div v-else-if="resp" style="padding:4px 10px 6px;border-top:1px solid #ddd6fe;font-size:10px">
          <button style="background:none;border:none;font-size:10px;color:var(--text-3);cursor:pointer;font-family:inherit"
                  @click.stop="respOpen=!respOpen">{{ respOpen ? '▼' : '▶' }} response</button>
          <pre v-if="respOpen" class="n-leaf__resp" style="margin-left:0;margin-top:4px">{{ resp }}</pre>
        </div>
        <div v-if="isExpanded && hasKids" class="n-skill__children">
          <template v-for="(g,gi) in childGroups" :key="gi">
            <flow-node v-if="g.type==='single'||g.type==='parallel'" v-for="c in g.nodes" :key="c.id"
                       :node="c" :token-index="tokenIndex" :depth="depth+1" :expanded-set="expandedSet" @toggle="$emit('toggle',$event)" />
            <div v-else-if="g.type==='cmdgroup'" class="n-cmdgroup">
              <div class="n-cmdgroup__hdr" @click="toggleGroup(g.nodes[0].id)">
                <span class="n-cmdgroup__count">{{ g.nodes.length }} operations</span>
                <div class="n-cmdgroup__tools">
                  <span v-for="t in cmdSummary(g.nodes).tools" :key="t.tool" :class="['n-cmdgroup__pill', t.tag]">{{ t.tool }}{{ t.count>1?' ×'+t.count:'' }}</span>
                </div>
                <span class="n-cmdgroup__chev">{{ collapsedGroups.has(g.nodes[0].id) ? '▶' : '▼' }}</span>
              </div>
              <div class="n-cmdgroup__body" v-if="!collapsedGroups.has(g.nodes[0].id)">
                <flow-node v-for="c in g.nodes" :key="c.id" :node="c" :token-index="tokenIndex"
                           :depth="depth+1" :expanded-set="expandedSet" @toggle="$emit('toggle',$event)" />
              </div>
            </div>
          </template>
        </div>
      </div>

      <!-- ═══ LEAF NODE — compact single row ═══ -->
      <div v-else>
        <div :class="['n-leaf', hasKids ? 'n-leaf--expandable' : '']" @click="toggle">
          <span v-if="hasKids" class="n-leaf__toggle">{{ isExpanded ? '▼' : '▶' }}</span>
          <span :class="['n-leaf__tag', tagClass]">{{ node.tool }}</span>
          <span class="n-leaf__label" :title="label">{{ label || '—' }}</span>
          <span v-if="hasKids" class="n-leaf__toggle" style="font-size:9px;color:var(--text-3)">{{ node.children.length }}</span>
          <span v-if="hasTok" class="n-leaf__tokens">
            <span class="t-in">&uarr;{{ fmtK(totalIn) }}</span>
            <span class="t-out">&darr;{{ fmtK(totalOut) }}</span>
            <span v-if="tok.duration_ms" class="t-dur">{{ tok.duration_ms }}ms</span>
          </span>
          <span v-if="node.status==='active'" class="n-leaf__status">RUNNING</span>
          <button v-if="resp" class="n-leaf__resp-btn" @click.stop="respOpen=!respOpen">{{ respOpen ? '▼' : '▶' }}</button>
        </div>
        <pre v-if="respOpen && resp" class="n-leaf__resp">{{ resp }}</pre>
        <div v-if="isExpanded && hasKids" class="n-leaf__children">
          <flow-node v-for="c in node.children" :key="c.id" :node="c" :token-index="tokenIndex"
                     :depth="depth+1" :expanded-set="expandedSet" @toggle="$emit('toggle',$event)" />
        </div>
      </div>
    </div>
  `
};
FlowNode.components = { 'flow-node': FlowNode };

// ─── Process / BPMN Node Component ──────────────────────────────────────
const ProcessNode = {
  name: 'ProcessNode',
  props: { node: Object, sessionTreeMap: Object, sessionDescMap: Object },
  setup(props) {
    const isAgent = computed(() => props.node.tool === 'Agent');
    const isSkill = computed(() => props.node.tool === 'Skill');
    const isUser = computed(() => props.node.tool === 'User' || props.node.tool === 'Command');
    const isSkillListing = computed(() => props.node.tool === 'SkillListing');
    const skillsOpen = ref(false);

    const childTree = computed(() => {
      if (!isAgent.value || !props.sessionDescMap || !props.sessionTreeMap) return null;
      const desc = String(props.node.input?.description || '').trim();
      if (!desc) return null;
      const sid = props.sessionDescMap.get(desc);
      return sid ? (props.sessionTreeMap.get(sid) || null) : null;
    });

    const isContainer = computed(() =>
      (isAgent.value || isSkill.value) && (props.node.children?.length > 0 || !!childTree.value)
    );
    const label = computed(() => getLabel(props.node));
    const desc = computed(() => getDescription(props.node));

    function taskClass(tool) {
      if (!tool) return 'bp-task--default';
      if (tool === 'Agent') return 'bp-task--agent';
      if (tool === 'Skill' || tool === 'AgentSetting' || tool === 'SkillRead' || tool === 'SkillInjected') return 'bp-task--skill';
      if (tool === 'User' || tool === 'Command') return 'bp-task--user';
      if (tool === 'Bash') return 'bp-task--bash';
      if (tool === 'Read' || tool === 'Glob' || tool === 'Grep') return 'bp-task--read';
      if (tool === 'Edit' || tool === 'Write') return 'bp-task--edit';
      if (tool === 'SendMessage') return 'bp-task--send';
      if (tool?.startsWith('mcp__')) return 'bp-task--mcp';
      return 'bp-task--default';
    }

    function toolIcon(tool) {
      if (tool === 'Agent') return 'A';
      if (tool === 'Skill') return 'S';
      if (tool === 'AgentSetting') return '⚙';
      if (tool === 'SkillListing') return '⚙';
      if (tool === 'SkillRead') return '📖';
      if (tool === 'SkillInjected') return '⤓';
      if (tool === 'User' || tool === 'Command') return '✍';
      if (tool === 'Bash') return '$';
      if (tool === 'Read' || tool === 'Glob' || tool === 'Grep') return '⚐';
      if (tool === 'Edit' || tool === 'Write') return '✎';
      if (tool === 'SendMessage') return '✉';
      if (tool?.startsWith('mcp__')) return 'M';
      return '•';
    }

    const childGroups = computed(() => {
      const kids = props.node.children || [];
      if (!kids.length) return [];

      // If every child is an Agent and each links to a loaded child session,
      // treat them all as parallel even when the log shows them sequentially.
      const allAgentsWithSessions = kids.length > 1
        && kids.every(ch => ch.tool === 'Agent')
        && props.sessionDescMap
        && kids.every(ch => {
          const desc = String(ch.input?.description || '').trim();
          return desc && props.sessionDescMap.get(desc);
        });
      if (allAgentsWithSessions) return [{ parallel: true, nodes: kids }];

      const groups = []; let pb = [];
      for (const ch of kids) {
        if (ch.parallel) pb.push(ch);
        else { if (pb.length) { groups.push({ parallel: true, nodes: pb }); pb = []; } groups.push({ parallel: false, nodes: [ch] }); }
      }
      if (pb.length) groups.push({ parallel: true, nodes: pb });
      return groups;
    });

    const skillGroups = computed(() => groupSkills(props.node.input?.skills));

    const injOpen = ref(false);
    function toggleInj(e) { if (e) e.stopPropagation(); injOpen.value = !injOpen.value; }
    const injFields = computed(() => {
      const inp = props.node?.input || {};
      const order = ['subagent_type', 'agent', 'description', 'model', 'team_name', 'isolation', 'mode', 'name', 'run_in_background'];
      const out = [];
      for (const k of order) {
        if (inp[k] != null && inp[k] !== '') out.push({ key: k, value: String(inp[k]), long: false });
      }
      for (const k of Object.keys(inp)) {
        if (order.includes(k) || k === 'prompt') continue;
        const v = inp[k];
        if (v == null || v === '') continue;
        const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
        out.push({ key: k, value: s, long: s.length > 120 || s.includes('\n') });
      }
      if (inp.prompt) out.push({ key: 'prompt', value: String(inp.prompt), long: true });
      return out;
    });

    return { isAgent, isSkill, isContainer, isUser, isSkillListing, skillsOpen, skillGroups, label, desc, taskClass, toolIcon, childGroups, childTree, injOpen, toggleInj, injFields };
  },
  template: `
    <div class="bp-flow">
      <div class="bp-conn"></div>
      <div v-if="isContainer" :class="['bp-subprocess', isSkill ? 'bp-subprocess--skill' : '']">
        <div class="bp-subprocess__hdr">
          <div :class="['bp-subprocess__icon', isAgent ? 'bp-subprocess__icon--agent' : 'bp-subprocess__icon--skill']">
            {{ isAgent ? 'A' : 'S' }}
          </div>
          <span class="bp-subprocess__name">{{ label }}</span>
          <span v-if="desc" class="bp-subprocess__desc">{{ desc }}</span>
          <span v-if="isSkill && node.invokerChain && node.invokerChain.length" class="bp-task__invoker" style="margin-left:8px">by: {{ node.invokerChain.join(' › ') }}</span>
          <button v-if="isAgent && injFields.length" class="sa-inj-btn" style="margin-left:auto" @click.stop="toggleInj($event)"
                  :title="injOpen ? 'Hide spawn payload' : 'Show everything injected to this sub-agent'">
            {{ injOpen ? '&#x25BC;' : '&#x25B6;' }} payload
          </button>
          <span v-if="node.status==='active'" class="bp-task__status" style="color:var(--green)">&#x25CF; RUNNING</span>
        </div>
        <div v-if="isAgent && injOpen" class="sa-inj" style="margin:0 12px 4px">
          <div class="sa-inj__hdr">Injected to sub-agent (Agent tool input)</div>
          <div v-for="f in injFields" :key="f.key" class="sa-inj__field">
            <div class="sa-inj__key">{{ f.key }}</div>
            <div v-if="f.long" class="sa-inj__val sa-inj__val--long"><pre>{{ f.value }}</pre></div>
            <div v-else class="sa-inj__val">{{ f.value }}</div>
          </div>
        </div>
        <div class="bp-subprocess__body">
          <template v-for="(g, gi) in childGroups" :key="gi">
            <template v-if="g.parallel">
              <div class="bp-conn"></div>
              <div class="bp-gateway"><span class="bp-gateway__inner">+</span></div>
              <div class="bp-conn"></div>
              <div class="bp-parallel">
                <div v-for="c in g.nodes" :key="c.id" class="bp-branch">
                  <process-node :node="c" :session-tree-map="sessionTreeMap" :session-desc-map="sessionDescMap" />
                </div>
              </div>
              <div class="bp-conn"></div>
              <div class="bp-gateway"><span class="bp-gateway__inner">+</span></div>
            </template>
            <template v-else>
              <process-node v-for="c in g.nodes" :key="c.id" :node="c" :session-tree-map="sessionTreeMap" :session-desc-map="sessionDescMap" />
            </template>
          </template>
          <template v-if="childTree">
            <div v-if="childGroups.length" class="bp-conn"></div>
            <div class="bp-child-session-label">&#x21B3; spawned session</div>
            <process-node v-for="child in childTree.children" :key="child.id" :node="child" :session-tree-map="sessionTreeMap" :session-desc-map="sessionDescMap" />
          </template>
        </div>
      </div>
      <div v-else-if="isSkillListing" class="bp-skill-node" @click="skillsOpen = !skillsOpen">
        <div class="bp-skill-node__hdr">
          <div class="bp-task__icon" style="background:var(--skill);border-radius:5px;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#fff;flex-shrink:0">⚙</div>
          <div class="bp-task__body">
            <div class="bp-task__type" style="font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;color:var(--skill)">Skills loaded</div>
            <div class="bp-task__label">{{ node.input.skillCount }} skills &nbsp;<span style="color:var(--text-3);font-size:10px">{{ skillsOpen ? '▼' : '▶' }}</span></div>
          </div>
        </div>
        <div v-if="skillsOpen && skillGroups.length" class="skill-groups" @click.stop>
          <div v-for="g in skillGroups" :key="g.plugin" class="skill-group">
            <div class="skill-group__hdr">
              <span class="skill-group__name">{{ g.plugin }}</span>
              <span class="skill-group__count">({{ g.items.length }})</span>
            </div>
            <div class="skill-group__items">
              <div v-for="it in g.items" :key="it" class="skill-group__item">{{ it }}</div>
            </div>
          </div>
        </div>
      </div>
      <div v-else :class="['bp-task', taskClass(node.tool), node.tool==='SkillRead'?'bp-task--skillread':'', node.tool==='SkillInjected'?'bp-task--skillinjected':'', isAgent && injOpen ? 'bp-task--inj-open' : '']"
           :title="label + (node.invokerChain ? '\\nInvoked by: ' + node.invokerChain.join(' › ') : '') + (node.ts ? '\\nat: ' + node.ts.slice(11,19) : '')">
        <div class="bp-task__row">
          <div class="bp-task__icon">{{ toolIcon(node.tool) }}</div>
          <div class="bp-task__body">
            <div v-if="node.tool !== 'User' && node.tool !== 'Command'" class="bp-task__type">{{ node.tool }}</div>
            <div class="bp-task__label">{{ label || node.cmd || '—' }}</div>
            <div v-if="node.invokerChain && node.invokerChain.length" class="bp-task__invoker">by: {{ node.invokerChain.join(' › ') }}</div>
          </div>
          <button v-if="isAgent && injFields.length" class="sa-inj-btn" @click.stop="toggleInj($event)"
                  :title="injOpen ? 'Hide spawn payload' : 'Show everything injected to this sub-agent'">
            {{ injOpen ? '&#x25BC;' : '&#x25B6;' }} payload
          </button>
          <span v-if="node.status==='active'" class="bp-task__status" style="color:var(--green)">&#x25CF;</span>
        </div>
        <div v-if="isAgent && injOpen" class="sa-inj">
          <div class="sa-inj__hdr">Injected to sub-agent (Agent tool input)</div>
          <div v-for="f in injFields" :key="f.key" class="sa-inj__field">
            <div class="sa-inj__key">{{ f.key }}</div>
            <div v-if="f.long" class="sa-inj__val sa-inj__val--long"><pre>{{ f.value }}</pre></div>
            <div v-else class="sa-inj__val">{{ f.value }}</div>
          </div>
        </div>
      </div>
    </div>
  `
};
ProcessNode.components = { 'process-node': ProcessNode };

// ─── Sub-agent Flow View ─────────────────────────────────────────────────
const SubAgentFlowView = {
  name: 'SubAgentFlowView',
  props: {
    subAgentSessions: Array,  // [{ id, info, tree }]
    parentTree: Object,       // parent session root node (for matching Agent calls)
    sessionTreeMap: Object,
    sessionDescMap: Object,
    onNavigate: Function,
  },
  setup(props) {
    const items = computed(() => {
      if (!props.subAgentSessions?.length) return [];

      // Walk parent tree collecting Agent tool nodes indexed by description
      const agentNodesByDesc = new Map();
      function walk(node) {
        if (node.tool === 'Agent') {
          const desc = String(node.input?.description || '').trim();
          if (desc && !agentNodesByDesc.has(desc)) agentNodesByDesc.set(desc, node);
        }
        for (const child of (node.children || [])) walk(child);
      }
      if (props.parentTree) walk(props.parentTree);

      return props.subAgentSessions.map(sess => {
        const desc = (sess.info?.agent_description || '').trim();
        const agentNode = desc ? (agentNodesByDesc.get(desc) || null) : null;
        const agentType = agentNode
          ? String(agentNode.input?.agent || agentNode.input?.subagent_type || 'general-purpose')
          : (sess.info?.agent_name || 'general-purpose');
        const label = desc || sess.info?.title || '';
        return { sess, agentNode, agentType, label };
      });
    });

    const expanded = reactive(new Set());
    const injOpen = reactive(new Set());
    function toggle(id) { if (expanded.has(id)) expanded.delete(id); else expanded.add(id); }
    function toggleInj(id, e) { if (e) e.stopPropagation(); if (injOpen.has(id)) injOpen.delete(id); else injOpen.add(id); }
    function navigate(id, e) { e.stopPropagation(); if (props.onNavigate) props.onNavigate(id); }

    function injectionFields(agentNode) {
      const inp = agentNode?.input || {};
      const order = ['subagent_type', 'agent', 'description', 'model', 'team_name', 'isolation', 'mode', 'name', 'run_in_background'];
      const fields = [];
      for (const k of order) {
        if (inp[k] != null && inp[k] !== '') fields.push({ key: k, value: String(inp[k]), long: false });
      }
      for (const k of Object.keys(inp)) {
        if (order.includes(k) || k === 'prompt') continue;
        const v = inp[k];
        if (v == null || v === '') continue;
        const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
        fields.push({ key: k, value: s, long: s.length > 120 || s.includes('\n') });
      }
      if (inp.prompt) {
        fields.push({ key: 'prompt', value: String(inp.prompt), long: true });
      }
      return fields;
    }

    return { items, expanded, injOpen, toggle, toggleInj, navigate, injectionFields };
  },
  template: `
    <div class="sa-view">
      <div class="sa-view__banner">
        <div class="sa-view__banner-icon">&#x26A1;</div>
        <div class="sa-view__banner-title">Sub-agent sessions</div>
        <div class="sa-view__banner-count">{{ items.length }} spawned · click <b>payload</b> to inspect</div>
      </div>
      <div class="bp-conn"></div>
      <div class="bp-gateway"><span class="bp-gateway__inner">+</span></div>
      <div class="sa-fork">
        <div v-for="item in items" :key="item.sess.id" class="sa-branch">
          <div class="sa-fork-arm"></div>
          <!-- Agent call box -->
          <div :class="['sa-agent-call', injOpen.has(item.sess.id) ? 'sa-agent-call--open' : '']">
            <div class="sa-agent-call__row">
              <div class="sa-agent-call__icon">A</div>
              <div class="sa-agent-call__body">
                <div class="sa-agent-call__type">{{ item.agentType }}</div>
                <div v-if="item.sess.info?.attribution_skill" class="sa-agent-call__skill" :title="'Skill running this sub-agent'">&#x1F9E9; {{ item.sess.info.attribution_skill }}</div>
                <div v-if="item.label" class="sa-agent-call__label" :title="item.label">{{ item.label }}</div>
              </div>
              <button v-if="item.agentNode" class="sa-inj-btn"
                      @click.stop="toggleInj(item.sess.id, $event)"
                      :title="injOpen.has(item.sess.id) ? 'Hide spawn payload' : 'Show everything injected to this sub-agent'">
                {{ injOpen.has(item.sess.id) ? '&#x25BC;' : '&#x25B6;' }} payload
              </button>
              <span v-if="item.sess.info?.is_active" class="n-agent__status n-agent__status--active" style="font-size:8px">LIVE</span>
            </div>
            <div v-if="injOpen.has(item.sess.id) && item.agentNode" class="sa-inj">
              <div class="sa-inj__hdr">Injected to sub-agent (Agent tool input)</div>
              <div v-for="f in injectionFields(item.agentNode)" :key="f.key" class="sa-inj__field">
                <div class="sa-inj__key">{{ f.key }}</div>
                <div v-if="f.long" class="sa-inj__val sa-inj__val--long"><pre>{{ f.value }}</pre></div>
                <div v-else class="sa-inj__val">{{ f.value }}</div>
              </div>
              <div v-if="!injectionFields(item.agentNode).length" class="sa-inj__empty">No input recorded for this Agent call.</div>
            </div>
          </div>
          <!-- Downward arrow to session card -->
          <div class="sa-arrow"></div>
          <!-- Spawned session card -->
          <div :class="['sa-session', expanded.has(item.sess.id) ? 'sa-session--open' : '']">
            <div class="sa-session__hdr" @click="toggle(item.sess.id)">
              <div class="sa-session__icon">S</div>
              <span class="sa-session__name">{{ item.sess.info?.agent_name || item.sess.info?.agent_description || 'Sub-agent' }}</span>
              <span v-if="item.sess.info?.is_active" class="sess__live" style="font-size:8px;margin-left:4px">LIVE</span>
              <button class="tm-card__nav" @click.stop="navigate(item.sess.id, $event)" title="Open session">&#x2197;</button>
              <span class="sa-session__chev">{{ expanded.has(item.sess.id) ? '&#x25BC;' : '&#x25B6;' }}</span>
            </div>
            <div v-if="item.sess.info?.title" class="sa-session__title">{{ item.sess.info.title }}</div>
            <div v-if="expanded.has(item.sess.id)" class="sa-session__body">
              <template v-if="item.sess.tree && item.sess.tree.children?.length">
                <process-node v-for="child in item.sess.tree.children" :key="child.id"
                              :node="child" :session-tree-map="sessionTreeMap" :session-desc-map="sessionDescMap" />
              </template>
              <div v-else style="padding:16px;font-size:11px;color:var(--text-3);text-align:center">No process entries</div>
            </div>
          </div>
        </div>
      </div>
      <div class="bp-conn"></div>
      <div class="bp-gateway"><span class="bp-gateway__inner">+</span></div>
    </div>
  `
};
SubAgentFlowView.components = { 'process-node': ProcessNode };

// ─── Team View ────────────────────────────────────────────────────────────
const TeamView = {
  name: 'TeamView',
  props: { teamSessions: Array, sessionTreeMap: Object, sessionDescMap: Object, onNavigate: Function },
  setup(props) {
    const expanded = reactive(new Set());
    function toggle(id) {
      if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
    }
    function navigate(id, e) {
      e.stopPropagation();
      if (props.onNavigate) props.onNavigate(id);
    }
    return { expanded, toggle, navigate };
  },
  template: `
    <div class="team-view">
      <div class="team-view__hdr">&#x229E; Team members</div>
      <div class="team-cards">
        <div v-for="s in teamSessions" :key="s.id"
             :class="['tm-card', expanded.has(s.id) ? 'tm-card--expanded' : '']">
          <div class="tm-card__hdr" @click="toggle(s.id)">
            <span class="tm-card__agent">{{ s.info.agent_name || s.info.agent_description || 'Sub-agent' }}</span>
            <span v-if="s.info.attribution_skill" class="tm-card__skill" :title="'Skill running this sub-agent'">&#x1F9E9; {{ s.info.attribution_skill }}</span>
            <span v-if="s.info.is_active" class="tm-card__live">LIVE</span>
            <span class="tm-card__stats">{{ s.info.event_count }}ev</span>
            <button class="tm-card__nav" @click="navigate(s.id, $event)" title="Open this session">&#x2197;</button>
            <span class="tm-card__chev">{{ expanded.has(s.id) ? '▼' : '▶' }}</span>
          </div>
          <div v-if="s.info.title" class="tm-card__title">{{ s.info.title }}</div>
          <div v-if="expanded.has(s.id)" class="tm-card__body">
            <template v-if="s.tree && s.tree.children.length">
              <process-node v-for="child in s.tree.children" :key="child.id"
                            :node="child" :session-tree-map="sessionTreeMap" :session-desc-map="sessionDescMap" />
            </template>
            <div v-else class="empty" style="padding:24px 16px;font-size:11px">No process entries</div>
          </div>
        </div>
      </div>
    </div>
  `
};
TeamView.components = { 'process-node': ProcessNode };

// ─── Step Lane (recursive stepped view) ──────────────────────────────────
const StepLane = {
  name: 'StepLane',
  props: {
    node: Object,
    tokenIndex: Object,
    sessionTreeMap: Object,
    sessionDescMap: Object,
    onNavigate: Function,
    depth: { type: Number, default: 0 },
    stepNumberPrefix: { type: String, default: '' },
  },
  setup(props) {
    const steps = computed(() => groupIntoSteps(props.node));
    const userOverrides = reactive({});
    function toggle(key) { userOverrides[key] = !isOpen(key); }
    function defaultOpen(stepKind) { return stepKind === 'orch' || stepKind === 'parallel'; }
    function isOpen(key) {
      if (key in userOverrides) return userOverrides[key];
      const i = parseInt(key.replace(/^s/, ''), 10);
      const s = steps.value[i];
      return s ? defaultOpen(s.kind) : false;
    }
    function stepNum(i) { return props.stepNumberPrefix ? `${props.stepNumberPrefix}.${i+1}` : String(i+1); }
    function navigate(id, e) { e?.stopPropagation?.(); if (props.onNavigate) props.onNavigate(id); }
    function agentChildSession(node) { return resolveAgentSubtree(node, props.sessionDescMap, props.sessionTreeMap); }
    function agentChildSessionId(node) {
      if (!props.sessionDescMap) return null;
      const desc = String(node.input?.description || '').trim();
      return desc ? (props.sessionDescMap.get(desc) || null) : null;
    }
    function aggregate(nodes) { return aggregateStep(nodes); }
    function getLabelFor(n) { return getLabel(n); }
    function getDescFor(n) { return getDescription(n); }
    function agentType(n) {
      const i = n.input || {};
      return i.agent || i.subagent_type || 'general-purpose';
    }
    return { steps, toggle, isOpen, stepNum, navigate, agentChildSession, agentChildSessionId,
             aggregate, getLabelFor, getDescFor, agentType, groupSkills, fmtT, fmtK, fmtDur };
  },
  template: `
    <div class="sl-lane">
      <template v-for="(s, i) in steps" :key="i">
        <div class="sl-conn" v-if="i > 0"></div>

        <!-- ── SOLO step (User prompt, command, etc.) ── -->
        <div v-if="s.kind==='solo'" class="sl-step sl-step--solo">
          <div class="sl-step__num">{{ stepNum(i) }}</div>
          <div class="sl-step__body">
            <div class="sl-step__hdr"
                 :style="s.nodes[0].tool==='SkillListing' && s.nodes[0].input?.skills?.length ? 'cursor:pointer' : ''"
                 @click="s.nodes[0].tool==='SkillListing' && s.nodes[0].input?.skills?.length ? toggle('s'+i) : null">
              <span class="sl-tag" :class="'ltag-'+s.nodes[0].tool.toLowerCase()">{{ s.nodes[0].tool }}</span>
              <span class="sl-step__title">{{ getLabelFor(s.nodes[0]) || '—' }}</span>
              <span class="sl-step__time">{{ fmtT(s.nodes[0].ts) }}</span>
              <span v-if="s.nodes[0].tool==='SkillListing' && s.nodes[0].input?.skills?.length"
                    class="sl-step__chev">{{ isOpen('s'+i) ? '▼' : '▶' }}</span>
            </div>
            <div v-if="getDescFor(s.nodes[0])" class="sl-step__desc">{{ getDescFor(s.nodes[0]) }}</div>
            <div v-if="s.nodes[0].invokerChain && s.nodes[0].invokerChain.length"
                 class="sl-step__invoker">by: {{ s.nodes[0].invokerChain.join(' › ') }}</div>
            <div v-if="s.nodes[0].tool==='SkillListing' && isOpen('s'+i) && s.nodes[0].input?.skills?.length"
                 class="skill-groups" style="border-top:none;padding:6px 0">
              <div v-for="g in groupSkills(s.nodes[0].input.skills)" :key="g.plugin" class="skill-group">
                <div class="skill-group__hdr">
                  <span class="skill-group__name">{{ g.plugin }}</span>
                  <span class="skill-group__count">({{ g.items.length }})</span>
                </div>
                <div class="skill-group__items">
                  <div v-for="it in g.items" :key="it" class="skill-group__item">{{ it }}</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- ── SEQ step (sequential tool calls) ── -->
        <div v-else-if="s.kind==='seq'" class="sl-step sl-step--seq" :class="isOpen('s'+i) ? 'sl-step--open' : ''">
          <div class="sl-step__num">{{ stepNum(i) }}</div>
          <div class="sl-step__body">
            <div class="sl-step__hdr" @click="toggle('s'+i)">
              <span class="sl-step__kind">SEQUENTIAL</span>
              <span class="sl-step__count">{{ s.nodes.length }} ops</span>
              <div class="sl-chips">
                <span v-for="t in aggregate(s.nodes).tools" :key="t.tool" :class="['sl-chip', t.tag]">
                  {{ t.tool }}<span v-if="t.count>1"> ×{{ t.count }}</span>
                </span>
              </div>
              <span class="sl-step__meta">
                <span v-if="aggregate(s.nodes).span" class="sl-meta__dur">{{ fmtDur(aggregate(s.nodes).span) }}</span>
                <span v-if="aggregate(s.nodes).inT" class="t-in">&uarr;{{ fmtK(aggregate(s.nodes).inT) }}</span>
                <span v-if="aggregate(s.nodes).outT" class="t-out">&darr;{{ fmtK(aggregate(s.nodes).outT) }}</span>
              </span>
              <span class="sl-step__chev">{{ isOpen('s'+i) ? '▼' : '▶' }}</span>
            </div>
            <div v-if="isOpen('s'+i)" class="sl-step__detail">
              <flow-node v-for="c in s.nodes" :key="c.id" :node="c" :token-index="tokenIndex"
                         :depth="depth+1" :expanded-set="new Set(s.nodes.map(n=>n.id))" @toggle="()=>{}" />
            </div>
          </div>
        </div>

        <!-- ── ORCH step (single Agent or Skill) ── -->
        <div v-else-if="s.kind==='orch'" class="sl-step sl-step--orch" :class="[s.nodes[0].tool==='Skill'?'sl-step--skill':'sl-step--agent', isOpen('s'+i)?'sl-step--open':'']">
          <div class="sl-step__num">{{ stepNum(i) }}</div>
          <div class="sl-step__body">
            <div class="sl-step__hdr" @click="toggle('s'+i)">
              <span class="sl-step__kind">{{ s.nodes[0].tool === 'Skill' ? 'SKILL' : 'SUB-AGENT' }}</span>
              <span class="sl-step__title">{{ getLabelFor(s.nodes[0]) }}</span>
              <span v-if="getDescFor(s.nodes[0])" class="sl-step__desc-inline">— {{ getDescFor(s.nodes[0]) }}</span>
              <span v-if="s.nodes[0].tool==='Skill' && s.nodes[0].invokerChain && s.nodes[0].invokerChain.length"
                    class="sl-step__invoker-inline">by: {{ s.nodes[0].invokerChain.join(' › ') }}</span>
              <span class="sl-step__meta">
                <span v-if="aggregate(s.nodes).span" class="sl-meta__dur">{{ fmtDur(aggregate(s.nodes).span) }}</span>
                <span v-if="s.nodes[0].status==='active'" class="sl-live">● LIVE</span>
              </span>
              <span class="sl-step__chev">{{ isOpen('s'+i) ? '▼' : '▶' }}</span>
            </div>
            <div v-if="isOpen('s'+i)" class="sl-step__detail">
              <template v-if="agentChildSession(s.nodes[0])">
                <step-lane :node="agentChildSession(s.nodes[0])" :token-index="tokenIndex"
                           :session-tree-map="sessionTreeMap" :session-desc-map="sessionDescMap"
                           :on-navigate="onNavigate" :depth="depth+1" :step-number-prefix="stepNum(i)" />
              </template>
              <template v-else-if="s.nodes[0].children?.length">
                <step-lane :node="s.nodes[0]" :token-index="tokenIndex"
                           :session-tree-map="sessionTreeMap" :session-desc-map="sessionDescMap"
                           :on-navigate="onNavigate" :depth="depth+1" :step-number-prefix="stepNum(i)" />
              </template>
              <div v-else class="sl-empty">No nested operations</div>
            </div>
          </div>
        </div>

        <!-- ── PARALLEL step (multiple sub-agents in parallel) ── -->
        <div v-else-if="s.kind==='parallel'" class="sl-step sl-step--parallel" :class="isOpen('s'+i)?'sl-step--open':''">
          <div class="sl-step__num">{{ stepNum(i) }}</div>
          <div class="sl-step__body">
            <div class="sl-step__hdr" @click="toggle('s'+i)">
              <span class="sl-step__kind">PARALLEL</span>
              <span class="sl-step__title">Launch {{ s.nodes.length }} sub-agents in parallel</span>
              <div class="sl-agent-pills">
                <span v-for="n in s.nodes" :key="n.id" class="sl-agent-pill">{{ agentType(n) }}</span>
              </div>
              <span class="sl-step__meta">
                <span v-if="aggregate(s.nodes).span" class="sl-meta__dur">{{ fmtDur(aggregate(s.nodes).span) }}</span>
              </span>
              <span class="sl-step__chev">{{ isOpen('s'+i) ? '▼' : '▶' }}</span>
            </div>
            <div v-if="isOpen('s'+i)" class="sl-step__detail sl-step__detail--bpmn">
              <div class="sl-bpmn-conn"></div>
              <div class="sl-bpmn-gateway"><span class="sl-bpmn-gateway__inner">+</span></div>
              <div class="sl-bpmn-conn"></div>
              <div class="sl-cols">
                <div v-for="(n, ni) in s.nodes" :key="n.id" class="sl-col">
                  <div class="sl-col__hdr">
                    <span class="sl-col__type">{{ agentType(n) }}</span>
                    <button v-if="agentChildSessionId(n)"
                            class="sl-col__nav" @click="navigate(agentChildSessionId(n), $event)"
                            title="Open this sub-agent's session">↗</button>
                  </div>
                  <div v-if="getLabelFor(n)" class="sl-col__label" :title="getLabelFor(n)">{{ getLabelFor(n) }}</div>
                  <div v-if="getDescFor(n)" class="sl-col__desc">{{ getDescFor(n) }}</div>
                  <div class="sl-col__lane">
                    <step-lane v-if="agentChildSession(n)"
                               :node="agentChildSession(n)" :token-index="tokenIndex"
                               :session-tree-map="sessionTreeMap" :session-desc-map="sessionDescMap"
                               :on-navigate="onNavigate" :depth="depth+1" :step-number-prefix="stepNum(i)+'.'+(ni+1)" />
                    <step-lane v-else-if="n.children?.length"
                               :node="n" :token-index="tokenIndex"
                               :session-tree-map="sessionTreeMap" :session-desc-map="sessionDescMap"
                               :on-navigate="onNavigate" :depth="depth+1" :step-number-prefix="stepNum(i)+'.'+(ni+1)" />
                    <div v-else class="sl-empty">No nested operations yet</div>
                  </div>
                  <div v-if="n.status==='active'" class="sl-col__live">● LIVE</div>
                </div>
              </div>
              <div class="sl-bpmn-conn"></div>
              <div class="sl-bpmn-gateway"><span class="sl-bpmn-gateway__inner">+</span></div>
            </div>
          </div>
        </div>
      </template>
      <div v-if="!steps.length" class="sl-empty">No steps</div>
    </div>
  `
};
StepLane.components = { 'flow-node': FlowNode, 'step-lane': StepLane };

// ─── Diagram View (Mermaid) ──────────────────────────────────────────────
let mermaidPromise = null;
function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(m => {
      const mer = m.default || m;
      mer.initialize({
        startOnLoad: false,
        theme: 'base',
        securityLevel: 'loose',
        flowchart: { htmlLabels: true, curve: 'basis', padding: 14 },
        themeVariables: {
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          fontSize: '12px',
          primaryColor: '#eff6ff',
          primaryBorderColor: '#2563eb',
          lineColor: '#94a3b8',
        },
      });
      return mer;
    });
  }
  return mermaidPromise;
}

const DiagramView = {
  name: 'DiagramView',
  props: {
    tree: Object,
    sessionTreeMap: Object,
    sessionDescMap: Object,
    onNavigate: Function,
  },
  setup(props) {
    const containerRef = ref(null);
    const viewportRef = ref(null);
    const direction = ref('TD');
    const maxDepth = ref(3);
    const liveUpdate = ref(false);
    const error = ref('');
    const source = ref('');
    const rendering = ref(false);
    const zoom = ref(1);
    const pan = ref({ x: 0, y: 0 });
    const panning = ref(false);
    let panStart = { x: 0, y: 0, panX: 0, panY: 0 };
    let renderToken = 0;
    let renderDebounce = null;

    const ZOOM_MIN = 0.2;
    const ZOOM_MAX = 4;
    function clampZoom(z) { return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z)); }

    function zoomAt(clientX, clientY, factor) {
      if (!viewportRef.value) return;
      const rect = viewportRef.value.getBoundingClientRect();
      const mx = clientX - rect.left;
      const my = clientY - rect.top;
      const newZoom = clampZoom(zoom.value * factor);
      const realFactor = newZoom / zoom.value;
      pan.value = {
        x: mx - (mx - pan.value.x) * realFactor,
        y: my - (my - pan.value.y) * realFactor,
      };
      zoom.value = newZoom;
    }

    function onWheel(ev) {
      ev.preventDefault();
      const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
      zoomAt(ev.clientX, ev.clientY, factor);
    }

    function onMouseDown(ev) {
      // Only left-button drags on empty canvas (let nodes still receive clicks via stopPropagation in svg handlers)
      if (ev.button !== 0) return;
      panning.value = true;
      tooltip.value = { visible: false, x: 0, y: 0, data: null };
      panStart = { x: ev.clientX, y: ev.clientY, panX: pan.value.x, panY: pan.value.y };
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
    }
    function onMouseMove(ev) {
      if (!panning.value) return;
      pan.value = {
        x: panStart.panX + (ev.clientX - panStart.x),
        y: panStart.panY + (ev.clientY - panStart.y),
      };
    }
    function onMouseUp() {
      panning.value = false;
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    }

    function zoomIn() {
      const r = viewportRef.value?.getBoundingClientRect();
      if (r) zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.2);
    }
    function zoomOut() {
      const r = viewportRef.value?.getBoundingClientRect();
      if (r) zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.2);
    }
    function resetView() {
      zoom.value = 1;
      pan.value = { x: 0, y: 0 };
    }
    function fitToView() {
      if (!viewportRef.value || !containerRef.value) return;
      const svg = containerRef.value.querySelector('svg');
      if (!svg) return;
      const vp = viewportRef.value.getBoundingClientRect();
      // Reset transform briefly to measure natural size
      const prevTransform = containerRef.value.style.transform;
      containerRef.value.style.transform = 'translate(0px, 0px) scale(1)';
      const bbox = svg.getBoundingClientRect();
      containerRef.value.style.transform = prevTransform;
      if (!bbox.width || !bbox.height) return;
      const pad = 24;
      const z = clampZoom(Math.min(
        (vp.width - pad * 2) / bbox.width,
        (vp.height - pad * 2) / bbox.height,
      ));
      zoom.value = z;
      pan.value = {
        x: (vp.width - bbox.width * z) / 2,
        y: (vp.height - bbox.height * z) / 2,
      };
    }

    // Expose navigation function for Mermaid click directives.
    // Re-bound every render so the latest onNavigate handler is used.
    window.__loomNavigate = (sid) => { if (props.onNavigate) props.onNavigate(sid); };

    const tooltip = ref({ visible: false, x: 0, y: 0, data: null });
    let nodeMeta = {};

    function buildTooltipHtml(d) {
      if (!d) return '';
      const fmtTs = (ts) => ts ? ts.replace('T', ' ').slice(0, 19) + ' UTC' : '';
      const escHtml = (s) => String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const parts = [];
      parts.push(`<div class="dg-tip__title">${escHtml(d.title || '')}</div>`);
      if (d.description) parts.push(`<div class="dg-tip__desc">${escHtml(d.description)}</div>`);
      const tsLine = [];
      if (d.ts || d.tsStart) tsLine.push(`<span>start: ${fmtTs(d.ts || d.tsStart)}</span>`);
      if (d.postTs || d.tsEnd) tsLine.push(`<span>end: ${fmtTs(d.postTs || d.tsEnd)}</span>`);
      if (d.duration) tsLine.push(`<span>dur: ${fmtDur(d.duration)}</span>`);
      if (tsLine.length) parts.push(`<div class="dg-tip__meta">${tsLine.join(' · ')}</div>`);
      const t = d.agg || { inT: d.inT, outT: d.outT, count: 0, dur: d.duration };
      const stats = [];
      if (t.count) stats.push(`${t.count} ops`);
      if (t.dur) stats.push(fmtDur(t.dur));
      if (t.inT) stats.push(`↑${fmtK(t.inT)} tokens in`);
      if (t.outT) stats.push(`↓${fmtK(t.outT)} tokens out`);
      if (stats.length) parts.push(`<div class="dg-tip__meta">${stats.join(' · ')}</div>`);
      if (d.ops?.length) {
        const opsHtml = d.ops.slice(0, 20).map(o =>
          `<li><b>${escHtml(o.tool)}</b> ${escHtml((o.label||'').slice(0, 80))}</li>`
        ).join('');
        const more = d.ops.length > 20 ? `<li class="dg-tip__more">+${d.ops.length - 20} more</li>` : '';
        parts.push(`<ul class="dg-tip__ops">${opsHtml}${more}</ul>`);
      }
      if (d.fullText) parts.push(`<div class="dg-tip__body">${escHtml(d.fullText)}</div>`);
      if (d.response) parts.push(`<div class="dg-tip__resp"><div class="dg-tip__resp-lbl">Response</div><pre>${escHtml(d.response)}</pre></div>`);
      if (d.sessionId) parts.push(`<div class="dg-tip__hint">Click to open sub-agent session →</div>`);
      return parts.join('');
    }

    function attachHoverHandlers() {
      if (!containerRef.value) return;
      const root = containerRef.value;
      // Mermaid renders SVG node ids like "flowchart-n0-1"; subgraph cluster ids like "n3"
      function clampPos(x, y) {
        const w = 460, h = 280, pad = 12;
        const vw = window.innerWidth, vh = window.innerHeight;
        if (x + w + pad > vw) x = Math.max(pad, vw - w - pad);
        if (y + h + pad > vh) y = Math.max(pad, vh - h - pad);
        return { x, y };
      }
      Object.entries(nodeMeta).forEach(([myId, data]) => {
        const candidates = [
          root.querySelector(`g[id^="flowchart-${myId}-"]`),
          root.querySelector(`g.cluster[id="${myId}"]`),
          root.querySelector(`g.cluster[id^="${myId}-"]`),
        ].filter(Boolean);
        const el = candidates[0];
        if (!el) return;
        el.style.cursor = data.sessionId ? 'pointer' : 'help';
        el.addEventListener('mouseenter', (ev) => {
          const p = clampPos(ev.clientX + 14, ev.clientY + 14);
          tooltip.value = { visible: true, x: p.x, y: p.y, data };
        });
        el.addEventListener('mousemove', (ev) => {
          if (tooltip.value.visible) {
            const p = clampPos(ev.clientX + 14, ev.clientY + 14);
            tooltip.value = { ...tooltip.value, x: p.x, y: p.y };
          }
        });
        el.addEventListener('mouseleave', () => {
          tooltip.value = { visible: false, x: 0, y: 0, data: null };
        });
      });
    }

    async function render() {
      if (!props.tree || !containerRef.value) return;
      rendering.value = true; error.value = '';
      const myToken = ++renderToken;
      try {
        const mer = await loadMermaid();
        if (myToken !== renderToken) return;
        const out = treeToMermaid(props.tree, {
          maxDepth: maxDepth.value,
          direction: direction.value,
          sessionTreeMap: props.sessionTreeMap,
          sessionDescMap: props.sessionDescMap,
        });
        source.value = out.source;
        nodeMeta = out.meta;
        const id = 'mmd-' + Date.now();
        const { svg, bindFunctions } = await mer.render(id, source.value);
        if (myToken !== renderToken) return;
        containerRef.value.innerHTML = svg;
        if (bindFunctions) bindFunctions(containerRef.value);
        attachHoverHandlers();
      } catch (e) {
        error.value = String(e?.message || e);
      } finally {
        rendering.value = false;
      }
    }

    function scheduleRender() {
      if (renderDebounce) clearTimeout(renderDebounce);
      renderDebounce = setTimeout(render, 250);
    }

    function copySource() {
      navigator.clipboard?.writeText(source.value);
    }
    function downloadSvg() {
      const svg = containerRef.value?.querySelector('svg');
      if (!svg) return;
      const blob = new Blob([svg.outerHTML], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'loomscope-diagram.svg';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    onMounted(() => render());
    watch(() => [direction.value, maxDepth.value], () => { resetView(); render(); });
    watch(() => props.tree, () => { if (liveUpdate.value) scheduleRender(); else render(); });

    onUnmounted(() => {
      if (window.__loomNavigate) delete window.__loomNavigate;
      if (renderDebounce) clearTimeout(renderDebounce);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    });

    return {
      containerRef, viewportRef, direction, maxDepth, liveUpdate, error, source, rendering,
      tooltip, buildTooltipHtml, copySource, downloadSvg, render,
      zoom, pan, panning, onWheel, onMouseDown, zoomIn, zoomOut, resetView, fitToView,
    };
  },
  template: `
    <div class="dg-wrap">
      <div class="dg-toolbar">
        <label class="dg-ctrl">Layout
          <select v-model="direction">
            <option value="TD">Top-down</option>
            <option value="LR">Left-right</option>
          </select>
        </label>
        <label class="dg-ctrl">Max depth
          <input type="number" min="1" max="6" v-model.number="maxDepth" style="width:48px" />
        </label>
        <label class="dg-ctrl"><input type="checkbox" v-model="liveUpdate" /> Live update</label>
        <button class="dg-btn" @click="render">Refresh</button>
        <button class="dg-btn" @click="copySource">Copy source</button>
        <button class="dg-btn" @click="downloadSvg">Download SVG</button>
        <span class="dg-zoom">
          <button class="dg-btn dg-btn--icon" @click="zoomOut" title="Zoom out (wheel down)">&minus;</button>
          <span class="dg-zoom__pct">{{ Math.round(zoom * 100) }}%</span>
          <button class="dg-btn dg-btn--icon" @click="zoomIn" title="Zoom in (wheel up)">+</button>
          <button class="dg-btn" @click="fitToView" title="Fit to view">Fit</button>
          <button class="dg-btn" @click="resetView" title="Reset to 100%">Reset</button>
        </span>
        <span v-if="rendering" class="dg-status">rendering…</span>
      </div>
      <div v-if="error" class="dg-error">Mermaid error: {{ error }}</div>
      <div ref="viewportRef"
           :class="['dg-viewport', panning ? 'dg-viewport--panning' : '']"
           @wheel="onWheel"
           @mousedown="onMouseDown">
        <div ref="containerRef" class="dg-svg"
             :style="{ transform: 'translate(' + pan.x + 'px, ' + pan.y + 'px) scale(' + zoom + ')', transformOrigin: '0 0' }"></div>
      </div>
      <div v-if="tooltip.visible" class="dg-tip"
           :style="{ left: tooltip.x + 'px', top: tooltip.y + 'px' }"
           v-html="buildTooltipHtml(tooltip.data)"></div>
    </div>
  `
};

// ─── Main App ────────────────────────────────────────────────────────────
const app = createApp({
  components: { 'flow-node': FlowNode, 'process-node': ProcessNode, 'team-view': TeamView, 'sub-agent-flow': SubAgentFlowView, 'step-lane': StepLane, 'diagram-view': DiagramView },
  setup() {
    const sidebarWidth = ref(280);
    const sidebarDragging = ref(false);

    function startSidebarResize(e) {
      sidebarDragging.value = true;
      const startX = e.clientX;
      const startWidth = sidebarWidth.value;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';

      function onMove(ev) {
        sidebarWidth.value = Math.max(180, Math.min(600, startWidth + ev.clientX - startX));
      }
      function onUp() {
        sidebarDragging.value = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      }
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }

    function startRawResize(e) {
      rawDragging.value = true;
      const startX = e.clientX;
      const startWidth = rawPanelWidth.value;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      function onMove(ev) {
        rawPanelWidth.value = Math.max(200, Math.min(900, startWidth - (ev.clientX - startX)));
      }
      function onUp() {
        rawDragging.value = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      }
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }

    function toggleRawLine(i) {
      if (openRawLines[i]) delete openRawLines[i];
      else openRawLines[i] = true;
    }

    const sessions = ref([]);
    const activeSession = ref(null);
    const entries = ref([]);
    const stats = ref(null);
    const liveConnected = ref(true);
    const reloading = ref(false);
    const tab = ref('flow');
    const autoScroll = ref(true);
    const sessionSearch = ref('');
    const eventSearch = ref('');
    const eventToolFilter = ref('');
    const eventDirFilter = reactive({ pre: true, post: true, command: true, prompt: true });
    const eventSkillsOnly = ref(false);
    const openResps = reactive({});
    const collapsedProjects = reactive({});
    const selectMode = ref(false);
    const selectedSessions = ref(new Set());
    const eventsTable = ref(null);
    const searchInput = ref(null);
    const rawPanel = ref(null);
    const showRawLog = ref(false);
    const rawPanelWidth = ref(420);
    const rawDragging = ref(false);
    const openRawLines = reactive({});

    // ── Settings state ───────────────────────────────────────────────────────
    const settingsOpen = ref(false);
    const settingsDraft = ref({ projectsDir: '', teamsDir: '' });
    const settingsSaved = ref({ projectsDir: '', teamsDir: '' });
    const settingsChanged = computed(() =>
      settingsDraft.value.projectsDir !== settingsSaved.value.projectsDir ||
      settingsDraft.value.teamsDir !== settingsSaved.value.teamsDir
    );

    const pathWarnings = ref([]);

    async function loadSettings() {
      try {
        const s = await window.electronAPI.getSettings();
        settingsDraft.value = { ...s };
        settingsSaved.value = { ...s };
      } catch(e) { console.error('[Settings] load failed:', e); }
    }

    async function checkPaths() {
      try {
        const ok = await window.electronAPI.checkSettings();
        const warns = [];
        if (!ok.projectsDir) warns.push({ key: 'projectsDir', label: 'Projects folder' });
        if (!ok.teamsDir) warns.push({ key: 'teamsDir', label: 'Teams folder' });
        pathWarnings.value = warns;
      } catch(e) { /* ignore */ }
    }

    async function browseFolder(key) {
      const folder = await window.electronAPI.selectFolder();
      if (folder) settingsDraft.value = { ...settingsDraft.value, [key]: folder };
    }

    async function saveSettings() {
      await window.electronAPI.setSettings({ ...settingsDraft.value });
      settingsSaved.value = { ...settingsDraft.value };
      await checkPaths();
    }

    // ── Teams state ──────────────────────────────────────────────────────────
    const teams = ref([]);
    const activeTeam = ref(null);
    const teamMessages = ref([]);
    const teamsCollapsed = ref(false);
    const teamFeed = ref(null);

    const activeTeamData = computed(() =>
      teams.value.find(t => t.name === activeTeam.value) || null
    );

    const agentMessageGroups = computed(() => {
      if (!activeTeamData.value) return [];
      return activeTeamData.value.members.map(m => ({
        agent: m,
        messages: teamMessages.value.filter(msg => msg.to === m.name || msg.to === m.agentId),
      }));
    });

    async function loadTeams() {
      if (!window.electronAPI.getTeams) return;
      try { teams.value = await window.electronAPI.getTeams(); }
      catch(e) { console.error('[Teams] loadTeams failed:', e); }
    }

    async function selectTeam(name) {
      activeTeam.value = name;
      tab.value = 'teams';
      try {
        teamMessages.value = await window.electronAPI.getTeamMessages(name);
      } catch(e) {}
    }

    function connectTeamsStream() {
      if (!window.electronAPI.onTeamsUpdate) return;
      window.electronAPI.onTeamsUpdate(async () => {
        await loadTeams();
        if (activeTeam.value) {
          try {
            teamMessages.value = await window.electronAPI.getTeamMessages(activeTeam.value);
          } catch(e) {}
        }
      });
    }

    const teamArchiving = ref(false);

    async function archiveCurrentTeam() {
      if (!activeTeam.value || teamArchiving.value) return;
      teamArchiving.value = true;
      try { await window.electronAPI.archiveTeam(activeTeam.value); }
      catch(e) { console.error('[Teams] archive failed:', e); }
      teamArchiving.value = false;
    }

    const revokedTeamPending = ref(null);
    const revokedArchiving = ref(false);

    function connectRevocationListener() {
      if (!window.electronAPI.onTeamRevoked) return;
      window.electronAPI.onTeamRevoked((teamName) => {
        revokedTeamPending.value = teamName;
      });
    }

    async function handleRevokedClose() {
      const name = revokedTeamPending.value;
      revokedTeamPending.value = null;
      if (activeTeam.value === name) {
        activeTeam.value = null;
        teamMessages.value = [];
      }
      await loadTeams();
    }

    async function handleRevokedArchive() {
      const name = revokedTeamPending.value;
      if (!name) return;
      revokedArchiving.value = true;
      try {
        await window.electronAPI.archiveTeam(name);
      } catch(e) { console.error('[Teams] archive failed:', e); }
      revokedArchiving.value = false;
      revokedTeamPending.value = null;
      if (activeTeam.value === name) {
        activeTeam.value = null;
        teamMessages.value = [];
      }
      await loadTeams();
    }
    // ── End Teams state ──────────────────────────────────────────────────────

    // ── Token analytics ──────────────────────────────────────────────────────
    const TOKEN_PRICES = { input: 3e-6, output: 15e-6, cache_create: 3.75e-6, cache_read: 0.3e-6 };

    function classifyTurnTools(tools) {
      if (!tools?.length) return 'Other';
      if (tools.some(t => t === 'Agent' || t === 'Skill')) return 'Delegation';
      if (tools.some(t => ['TaskCreate','TaskUpdate','TaskGet','TaskList','TaskStop','TaskOutput'].includes(t))) return 'Planning';
      if (tools.some(t => t === 'Edit' || t === 'Write' || t === 'MultiEdit')) return 'Coding';
      if (tools.some(t => t === 'Bash' || t === 'Command')) return 'Shell';
      if (tools.some(t => t === 'SendMessage')) return 'Messaging';
      if (tools.some(t => t.startsWith('mcp__'))) return 'MCP';
      if (tools.some(t => t === 'Read' || t === 'Glob' || t === 'Grep')) return 'Reading';
      return 'Other';
    }

    const tokenStats = computed(() => {
      if (!stats.value) return null;
      const t = stats.value.tokens;
      const total = t.input + t.output + t.cache_read + t.cache_create;
      if (!total) return null;

      const cost = t.input * TOKEN_PRICES.input + t.output * TOKEN_PRICES.output
                 + t.cache_create * TOKEN_PRICES.cache_create + t.cache_read * TOKEN_PRICES.cache_read;

      const allInput = t.input + t.cache_read + t.cache_create;
      const cacheHitRate = allInput > 0 ? (t.cache_read / allInput) * 100 : 0;

      // Per-category token totals from timeline
      const cats = {};
      const skillMap = {};   // skill name → token buckets
      const agentMap = {};   // agent type → token buckets
      for (const entry of (stats.value.timeline || [])) {
        const cat = classifyTurnTools(entry.tools);
        if (!cats[cat]) cats[cat] = { input: 0, output: 0, cache_read: 0, cache_create: 0 };
        cats[cat].input += entry.input || 0;
        cats[cat].output += entry.output || 0;
        cats[cat].cache_read += entry.cache_read || 0;
        cats[cat].cache_create += entry.cache_create || 0;

        for (const skill of (entry.skills || [])) {
          if (!skillMap[skill]) skillMap[skill] = { input: 0, output: 0, cache_read: 0, cache_create: 0 };
          skillMap[skill].input += entry.input || 0;
          skillMap[skill].output += entry.output || 0;
          skillMap[skill].cache_read += entry.cache_read || 0;
          skillMap[skill].cache_create += entry.cache_create || 0;
        }
        for (const agent of (entry.agents || [])) {
          if (!agentMap[agent]) agentMap[agent] = { input: 0, output: 0, cache_read: 0, cache_create: 0 };
          agentMap[agent].input += entry.input || 0;
          agentMap[agent].output += entry.output || 0;
          agentMap[agent].cache_read += entry.cache_read || 0;
          agentMap[agent].cache_create += entry.cache_create || 0;
        }
      }
      const catList = Object.entries(cats).map(([name, c]) => ({
        name,
        total: c.input + c.output + c.cache_read + c.cache_create,
        cost: c.input * TOKEN_PRICES.input + c.output * TOKEN_PRICES.output
            + c.cache_create * TOKEN_PRICES.cache_create + c.cache_read * TOKEN_PRICES.cache_read,
      })).sort((a, b) => b.total - a.total);
      const maxCatTotal = catList[0]?.total || 1;

      const skillList = Object.entries(skillMap).map(([name, c]) => ({
        name,
        total: c.input + c.output + c.cache_read + c.cache_create,
        cost: c.input * TOKEN_PRICES.input + c.output * TOKEN_PRICES.output
            + c.cache_create * TOKEN_PRICES.cache_create + c.cache_read * TOKEN_PRICES.cache_read,
      })).sort((a, b) => b.total - a.total);

      const agentList = Object.entries(agentMap).map(([name, c]) => ({
        name,
        total: c.input + c.output + c.cache_read + c.cache_create,
        cost: c.input * TOKEN_PRICES.input + c.output * TOKEN_PRICES.output
            + c.cache_create * TOKEN_PRICES.cache_create + c.cache_read * TOKEN_PRICES.cache_read,
      })).sort((a, b) => b.total - a.total);
      const maxDelegTotal = [...skillList, ...agentList].reduce((m, x) => Math.max(m, x.total), 1);

      // Tool call counts
      const toolList = Object.entries(stats.value.tools || {})
        .sort((a, b) => b[1] - a[1]).slice(0, 12);
      const maxToolCalls = toolList[0]?.[1] || 1;

      const agentRole = stats.value.agentRole || '';

      return { tokens: t, total, cost, cacheHitRate, catList, maxCatTotal, skillList, agentList, maxDelegTotal, toolList, maxToolCalls, agentRole };
    });
    // ── End Token analytics ───────────────────────────────────────────────────

    const treeData = shallowRef(null);
    const treeVersion = ref(0);
    const tree = computed(() => { treeVersion.value; return treeData.value?.root || null; });
    const tokenIndex = computed(() => { treeVersion.value; return buildTokenIndex(entries.value, stats.value?.timeline || []); });
    const topTools = computed(() => Object.entries(stats.value?.tools||{}).sort((a,b)=>b[1]-a[1]).slice(0,6));
    const rawLines = computed(() => entries.value.map(e => ({ compact: JSON.stringify(e), pretty: JSON.stringify(e, null, 2) })));

    const childSessionEntries = ref(new Map());
    const childSessionTreeMap = computed(() => {
      const map = new Map();
      for (const [sid, ents] of childSessionEntries.value) {
        if (ents.length) map.set(sid, buildTree(ents).root);
      }
      return map;
    });
    const childSessionDescMap = computed(() => {
      const map = new Map();
      for (const [sid] of childSessionEntries.value) {
        const info = sessionMap.value.get(sid);
        const desc = (info?.agent_description || '').trim();
        if (desc) map.set(desc, sid);
      }
      return map;
    });

    const isTeamLead = computed(() => {
      const info = sessionMap.value.get(activeSession.value);
      return !!(info?.team_name && !info?.agent_name);
    });

    const teamMemberSessions = computed(() => {
      if (!isTeamLead.value) return [];
      const info = sessionMap.value.get(activeSession.value);
      return (info?.child_ids || [])
        .map(id => ({
          id,
          info: sessionMap.value.get(id),
          tree: childSessionTreeMap.value.get(id) || null,
        }))
        .filter(s => s.info?.agent_name)
        .sort((a, b) => (a.info.first_ts || '').localeCompare(b.info.first_ts || ''));
    });

    const subAgentSessions = computed(() => {
      if (isTeamLead.value) return [];
      const info = sessionMap.value.get(activeSession.value);
      if (!info?.child_ids?.length) return [];
      return info.child_ids
        .map(id => ({
          id,
          info: sessionMap.value.get(id),
          tree: childSessionTreeMap.value.get(id) || null,
        }))
        .filter(s => s.info)
        .sort((a, b) => (a.info.first_ts || '').localeCompare(b.info.first_ts || ''));
    });

    async function loadChildSessions(parentId) {
      const info = sessionMap.value.get(parentId);
      if (!info?.child_ids?.length) return;
      const newMap = new Map(childSessionEntries.value);
      let changed = false;
      for (const childId of info.child_ids) {
        if (newMap.has(childId)) continue;
        try {
          const er = await window.electronAPI.getSession(childId);
          newMap.set(childId, er.entries || []);
          changed = true;
        } catch(e) {}
      }
      if (changed) childSessionEntries.value = newMap;
      for (const childId of info.child_ids) {
        await loadChildSessions(childId);
      }
    }

    const sessionTitle = computed(() => {
      if (!activeSession.value) return '';
      const first = entries.value.find(e => e.event === 'prompt' && e.tool === 'User');
      if (first?.cmd) return first.cmd;
      const info = sessionMap.value.get(activeSession.value);
      return info?.agent_description || info?.title || '';
    });

    const estimatedCost = computed(() => {
      const t = stats.value?.tokens; if (!t) return null;
      const cost = (t.input||0)*3/1e6 + (t.output||0)*15/1e6 + (t.cache_read||0)*0.30/1e6 + (t.cache_create||0)*3.75/1e6;
      return cost < 0.005 ? null : (cost < 1 ? cost.toFixed(2) : cost.toFixed(1));
    });

    const sessionDuration = computed(() => {
      if (!entries.value.length) return '';
      const first = entries.value[0]?.ts, last = entries.value[entries.value.length-1]?.ts;
      if (!first || !last) return '';
      const ms = new Date(last) - new Date(first);
      if (ms < 0) return '';
      const min = Math.floor(ms/60000), sec = Math.floor((ms%60000)/1000);
      return min>60 ? `${Math.floor(min/60)}h${min%60}m` : min>0 ? `${min}m${sec}s` : `${sec}s`;
    });

    const sessionMap = computed(() => {
      const map = new Map();
      for (const s of sessions.value) map.set(s.session_id, s);
      return map;
    });

    const expandedParents = reactive({});
    function toggleParentExpand(id) {
      if (expandedParents[id]) delete expandedParents[id];
      else expandedParents[id] = true;
    }

    const copiedSessionId = ref('');
    let copiedTimer = null;
    async function copySessionId(id, ev) {
      ev?.stopPropagation?.();
      ev?.preventDefault?.();
      if (!id) return;
      try {
        await navigator.clipboard.writeText(id);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = id; ta.style.position='fixed'; ta.style.opacity='0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch {}
        document.body.removeChild(ta);
      }
      copiedSessionId.value = id;
      if (copiedTimer) clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => { copiedSessionId.value = ''; }, 1500);
    }

    const activeParentSession = computed(() => {
      if (!activeSession.value) return null;
      const info = sessionMap.value.get(activeSession.value);
      if (!info?.parent_id) return null;
      return sessionMap.value.get(info.parent_id) || null;
    });

    const filteredProjectGroups = computed(() => {
      const q = sessionSearch.value.toLowerCase().trim();
      const allIds = new Set(sessions.value.map(s => s.session_id));
      // Exclude subagent sessions whose parent is present — they appear as children under the parent
      let list = sessions.value.filter(s => !s.parent_id || !allIds.has(s.parent_id));
      if (q) list = list.filter(s => (s.project||'').toLowerCase().includes(q) || (s.session_id||'').toLowerCase().includes(q) || (s.first_ts||'').includes(q));
      const map = {};
      for (const s of list) { const p=s.project||''; if (!map[p]) map[p]=[]; map[p].push(s); }
      const activeSess = sessionMap.value.get(activeSession.value);
      const ap = activeSess ? (activeSess.parent_id ? (sessionMap.value.get(activeSess.parent_id)?.project || activeSess.project) : activeSess.project) : '';
      return Object.entries(map).sort(([a],[b])=>{ if (a===ap) return -1; if (b===ap) return 1; return a.localeCompare(b); })
                   .map(([project,sessions])=>({project,sessions}));
    });

    function groupByDate(sl) {
      const groups = {};
      for (const s of sl) { const d=s.first_ts?s.first_ts.slice(0,10):'unknown'; if (!groups[d]) groups[d]=[]; groups[d].push(s); }
      const today = new Date().toISOString().slice(0,10), yday = new Date(Date.now()-864e5).toISOString().slice(0,10);
      return Object.entries(groups).map(([date,sessions])=>{
        let label = date;
        if (date===today) label='Today'; else if (date===yday) label='Yesterday';
        else { const d=new Date(date); if (!isNaN(d)) label=d.toLocaleDateString('en-US',{month:'short',day:'numeric'}); }
        return {label,sessions};
      });
    }
    function timeOf(ts) { return ts ? ts.slice(11,16) : '--:--'; }

    const availableTools = computed(() => { const s=new Set(); for (const e of entries.value) if (e.tool) s.add(e.tool); return [...s].sort(); });
    // Map action_id → invokerChain (computed from current tree)
    const invokerChainIndex = computed(() => {
      const m = new Map();
      if (!treeData.value?.nodeMap) return m;
      for (const n of treeData.value.nodeMap.values()) {
        if (n.invokerChain && n.id) m.set(n.id, n.invokerChain);
      }
      return m;
    });
    function invokerChainFor(e) {
      return invokerChainIndex.value.get(e.action_id) || null;
    }
    const filteredEvents = computed(() => {
      const q = eventSearch.value.toLowerCase().trim();
      const skillsOnly = eventSkillsOnly.value;
      return entries.value.map((e,i)=>({...e,_idx:i})).filter(e => {
        if (skillsOnly && !isSkillEvent(e.tool)) return false;
        if (!eventDirFilter[e.event]) return false;
        if (eventToolFilter.value && e.tool!==eventToolFilter.value) return false;
        if (q) { const s=summarise(e).toLowerCase(), t=(e.tool||'').toLowerCase(); if (!s.includes(q)&&!t.includes(q)) return false; }
        return true;
      });
    });

    // Index action_id → entry for fast post→pre tool lookup
    const actionIndex = computed(() => {
      const m = new Map();
      for (const e of entries.value) if (e.action_id) m.set(e.action_id, e);
      return m;
    });

    function resolvePostTool(e) {
      const pre = actionIndex.value.get(e.action_id);
      return pre?.tool || '';
    }

    function summarise(e) {
      if (e.event === 'post') {
        const r = e.response;
        if (!r && !e.cmd) return '(empty result)';
        const text = typeof r === 'string' ? r : (r?.stdout || r?.content || JSON.stringify(r) || '');
        return text.replace(/\s+/g, ' ').trim().slice(0, 120) || '(empty result)';
      }
      if (e.cmd) return e.cmd;
      const i=e.input||{};
      switch (e.tool) {
        case 'Agent': return `[${i.agent||i.subagent_type||'?'}] ${i.description||''}`;
        case 'Skill': return `${i.skill||''}${i.args?' '+i.args:''}`;
        case 'SendMessage': return `→ ${i.to||''}: ${(i.message||'').slice(0,80)}`;
        case 'TaskCreate': return i.title || JSON.stringify(i).slice(0,80);
        case 'TaskUpdate': return `${i.id||''} → ${i.status||''}`;
        case 'Bash': return i.description || (i.command||'').slice(0,80);
        case 'Read': case 'Glob': case 'Grep': return (i.path||i.file_path||i.pattern||'').split('/').slice(-3).join('/');
        case 'WebFetch': return String(i.url||'').replace(/^https?:\/\//,'') + (i.prompt?` — ${String(i.prompt).slice(0,60)}`:'');
        case 'WebSearch': return String(i.query||'');
        case 'Edit': case 'Write': return (i.file_path||'').split('/').slice(-3).join('/');
        case 'Command': return `${i.command||''} ${i.args||''}`.trim();
        case 'User': return (i.message||'').slice(0,120);
        case 'AgentSetting': return `skill: ${i.skill||''}`;
        case 'SkillListing': return `${i.skillCount ?? 0} skills available`;
        case 'SkillRead': return `read SKILL.md → ${i.plugin||''}:${i.skill||''}`;
        case 'SkillInjected': return `/${i.skill||e.cmd||''} (injected)`;
        default:
          if (e.tool?.startsWith('mcp__')) return e.tool.replace(/^mcp__[^_]+__/, '');
          return JSON.stringify(i).slice(0,100);
      }
    }
    function fmtResp(r) {
      if (r==null||r==='') return '';
      if (typeof r==='object') {
        if (r.stdout!=null||r.stderr!=null) { const p=[]; if (r.exit_code!=null&&r.exit_code!==0) p.push('exit: '+r.exit_code); if (r.stdout) p.push(String(r.stdout)); if (r.stderr) p.push('stderr: '+String(r.stderr)); if (r.interrupted) p.push('[interrupted]'); return p.join('\n')||'(empty)'; }
        if (r.files) return `${r.count||0} files: ${Array.isArray(r.files)?r.files.join(', '):r.files}`;
        if (r.matches) return `${r.num_files||0} files matched\n${r.matches}`;
        if (r.content) return extractContentText(r.content);
        return JSON.stringify(r,null,2);
      }
      return String(r);
    }
    function toolClass(tool) { if (!tool) return 'default'; if (tool.startsWith('mcp__')) return 'mcp'; return tool.toLowerCase(); }
    function toggleEventResp(i) { if (openResps[i]) delete openResps[i]; else openResps[i]=true; }
    function toggleProject(n) { if (collapsedProjects[n]) delete collapsedProjects[n]; else collapsedProjects[n]=true; }

    function isProjectFullySelected(grp) {
      return grp.sessions.length > 0 && grp.sessions.every(s => selectedSessions.value.has(s.session_id));
    }
    function isProjectPartiallySelected(grp) {
      return grp.sessions.some(s => selectedSessions.value.has(s.session_id)) && !isProjectFullySelected(grp);
    }
    function toggleProjectSelect(grp) {
      const s = new Set(selectedSessions.value);
      if (isProjectFullySelected(grp)) {
        grp.sessions.forEach(sess => s.delete(sess.session_id));
      } else {
        grp.sessions.forEach(sess => s.add(sess.session_id));
        if (collapsedProjects[grp.project]) delete collapsedProjects[grp.project];
      }
      selectedSessions.value = s;
    }

    function toggleSelectMode() {
      selectMode.value = !selectMode.value;
      if (!selectMode.value) selectedSessions.value = new Set();
    }
    function toggleSessionSelect(id) {
      const s = new Set(selectedSessions.value);
      if (s.has(id)) s.delete(id); else s.add(id);
      selectedSessions.value = s;
    }
    function selectAllVisible() {
      const s = new Set();
      for (const grp of filteredProjectGroups.value) {
        for (const sess of grp.sessions) s.add(sess.session_id);
      }
      selectedSessions.value = s;
    }

    let cleanupEntryListener = null;

    async function deleteSessions(ids) {
      try {
        await window.electronAPI.deleteSessions(ids);
        if (ids.includes(activeSession.value)) {
          activeSession.value = null; entries.value = []; stats.value = null;
          treeData.value = null; treeVersion.value++;
          cleanupEntryListener?.(); cleanupEntryListener = null;
        }
        await loadSessions();
      } catch(e) {}
    }
    async function deleteSingleSession(id) {
      if (!confirm('Delete this session? This removes the underlying Claude session file.')) return;
      await deleteSessions([id]);
    }
    async function deleteSelectedSessions() {
      const ids = [...selectedSessions.value];
      if (!ids.length) return;
      if (!confirm(`Delete ${ids.length} session${ids.length > 1 ? 's' : ''}? This removes the underlying Claude session files.`)) return;
      await deleteSessions(ids);
      selectedSessions.value = new Set();
      selectMode.value = false;
    }

    async function archiveSelectedSessions() {
      const ids = [...selectedSessions.value];
      if (!ids.length) return;
      try {
        const result = await window.electronAPI.archiveSessions(ids);
        if (result?.cancelled) return;
        selectedSessions.value = new Set();
        selectMode.value = false;
        await loadSessions();
      } catch(e) {}
    }
    async function loadSessions() {
      try {
        sessions.value = await window.electronAPI.getSessions();
        for (const s of sessions.value) {
          if (s.child_ids?.length && !(s.session_id in expandedParents)) {
            expandedParents[s.session_id] = true;
          }
        }
      } catch(e){}
    }

    async function reloadAll() {
      if (reloading.value) return;
      reloading.value = true;
      const prevActive = activeSession.value;
      try {
        await window.electronAPI.reloadSessions();
        await loadSessions();
        if (prevActive) {
          cleanupEntryListener?.(); cleanupEntryListener = null;
          activeSession.value = prevActive;
          entries.value = []; stats.value = null; treeData.value = null; treeVersion.value++;
          Object.keys(openResps).forEach(k => delete openResps[k]);
          Object.keys(openRawLines).forEach(k => delete openRawLines[k]);
          const [er, sr] = await Promise.all([
            window.electronAPI.getSession(prevActive),
            window.electronAPI.getStats(prevActive).catch(() => null),
          ]);
          entries.value = er.entries || []; stats.value = sr;
          if (entries.value.length) { treeData.value = buildTree(entries.value); treeVersion.value++; }
          await loadChildSessions(prevActive);
          connectEntryListener(prevActive);
        }
      } catch(e) {}
      finally { reloading.value = false; }
    }

    async function selectSession(id) {
      if (id===activeSession.value) return;
      cleanupEntryListener?.(); cleanupEntryListener = null;
      activeSession.value=id; entries.value=[]; stats.value=null; treeData.value=null; treeVersion.value++;
      Object.keys(openResps).forEach(k=>delete openResps[k]);
      Object.keys(openRawLines).forEach(k=>delete openRawLines[k]);
      childSessionEntries.value=new Map();
      try {
        const [er, sr] = await Promise.all([
          window.electronAPI.getSession(id),
          window.electronAPI.getStats(id).catch(()=>null),
        ]);
        if (id!==activeSession.value) return;
        entries.value = er.entries||[]; stats.value = sr;
        if (entries.value.length) { treeData.value = buildTree(entries.value); treeVersion.value++; }
        await loadChildSessions(id);
      } catch(e){}
      connectEntryListener(id);
    }

    function connectEntryListener(id) {
      cleanupEntryListener = window.electronAPI.onSessionEntry((data) => {
        if (data.sessionId !== id) return;
        const entry = data.entry;
        entries.value = [...entries.value, entry];
        treeData.value = buildTree(entries.value); treeVersion.value++;
        if (autoScroll.value) {
          nextTick(()=>{
            if (tab.value==='events' && eventsTable.value) eventsTable.value.scrollTop=eventsTable.value.scrollHeight;
            if (showRawLog.value && rawPanel.value) rawPanel.value.scrollTop=rawPanel.value.scrollHeight;
          });
        }
      });
    }

    function connectGlobalStream() {
      window.electronAPI.onGlobalUpdate(() => {
        loadSessions();
      });
    }

    function onKey(e) {
      if (e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA') { if (e.key==='Escape') e.target.blur(); return; }
      switch(e.key) {
        case '/': e.preventDefault(); searchInput.value?.focus(); break;
        case 'e': tab.value='events'; break;
        case 'd': tab.value='diagram'; break;
        case 'p': tab.value='flow'; break;
        case 'm': tab.value='teams'; break;
        case 'j': case 'ArrowDown': { e.preventDefault(); const items=[...document.querySelectorAll('.sess')]; const cur=items.findIndex(el=>el.classList.contains('sess--active')); if (items[cur+1]) items[cur+1].click(); break; }
        case 'k': case 'ArrowUp': { e.preventDefault(); const items=[...document.querySelectorAll('.sess')]; const cur=items.findIndex(el=>el.classList.contains('sess--active')); if (items[cur-1]) items[cur-1].click(); break; }
      }
    }

    watch(activeSession, (id) => {
      if (!id) return;
      const info = sessionMap.value.get(id);
      if (info?.parent_id) expandedParents[info.parent_id] = true;
    });

    let pollTimer = null;

    onMounted(async ()=>{
      await loadSettings();
      await checkPaths();
      await loadSessions();
      await loadTeams();
      connectGlobalStream();
      connectTeamsStream();
      connectRevocationListener();
      if (sessions.value.length) selectSession(sessions.value[0].session_id);
      document.addEventListener('keydown', onKey);
      pollTimer = setInterval(async () => { await loadSessions(); await loadTeams(); }, 30000);
    });
    onUnmounted(()=>{
      cleanupEntryListener?.();
      if (pollTimer) clearInterval(pollTimer);
      document.removeEventListener('keydown', onKey);
    });

    return { sidebarWidth, sidebarDragging, startSidebarResize,
             sessions, activeSession, entries, stats, liveConnected, reloading, reloadAll, tab, autoScroll,
             sessionSearch, eventSearch, eventToolFilter, eventDirFilter, eventSkillsOnly, invokerChainFor, isSkillEvent, openResps,
             collapsedProjects, eventsTable, searchInput,
             tree, tokenIndex, topTools, estimatedCost, sessionDuration,
             filteredProjectGroups, filteredEvents, availableTools,
             groupByDate, timeOf, fmtK, fmtT, summarise, fmtResp, toolClass, groupSkills,
             selectSession, toggleProject, toggleEventResp,
             selectMode, selectedSessions, toggleSelectMode,
             toggleSessionSelect, selectAllVisible, isProjectFullySelected, isProjectPartiallySelected, toggleProjectSelect,
             deleteSingleSession, deleteSelectedSessions,
             archiveSelectedSessions,
             sessionMap, expandedParents, toggleParentExpand, activeParentSession,
             copySessionId, copiedSessionId,
             showRawLog, rawPanelWidth, rawDragging, rawPanel, rawLines, openRawLines,
             startRawResize, toggleRawLine,
             sessionTitle,
             childSessionTreeMap, childSessionDescMap,
             isTeamLead, teamMemberSessions, subAgentSessions,
             teams, activeTeam, teamMessages, teamsCollapsed,
             activeTeamData, agentMessageGroups, loadTeams, selectTeam,
             teamArchiving, archiveCurrentTeam,
             revokedTeamPending, revokedArchiving,
             handleRevokedClose, handleRevokedArchive,
             tokenStats, fmtCost, fmtCostSmall,
             resolvePostTool,
             settingsOpen, settingsDraft, settingsChanged, browseFolder, saveSettings,
             pathWarnings };
  }
});
app.mount('#app');
