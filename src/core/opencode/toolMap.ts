// Maps OpenCode's tool-part shape onto Claude's AppEntry.tool/input convention so
// downstream display logic (LogParser.buildCmd, FlowBuilder.summarizeInput) works
// unmodified for both sources. Confirmed against a real opencode.db (Phase 0 recon):
// tool parts carry a flat `callID`, `state.status`, `state.input`, `state.output` —
// there is no nested tree, matching Claude's flat action_id (pre/post) convention.
export interface MappedTool {
  tool: string;
  input: Record<string, unknown>;
}

export function mapOpenCodeTool(tool: string, input: Record<string, unknown>): MappedTool {
  switch (tool) {
    case 'read':
    case 'write':
    case 'edit': {
      const { filePath, ...rest } = input;
      const mapped = tool === 'read' ? 'Read' : tool === 'write' ? 'Write' : 'Edit';
      return { tool: mapped, input: { file_path: filePath, ...rest } };
    }
    case 'bash':
      return { tool: 'Bash', input };
    case 'grep':
      return { tool: 'Grep', input };
    case 'glob':
      return { tool: 'Glob', input };
    case 'webfetch':
      return { tool: 'WebFetch', input };
    case 'task': {
      const { subagent_type, ...rest } = input;
      return { tool: 'Agent', input: { subagent_type, ...rest } };
    }
    case 'todowrite':
    case 'todoread':
    case 'skill':
    case 'question':
    case 'invalid':
    default:
      // Unrecognized/unmapped tools (including MCP tools, which arrive already
      // flattened as e.g. "codegraph_codegraph_context" — no "mcp__server__tool"
      // convention exists in OpenCode) pass through verbatim. buildCmd/summarizeInput
      // both degrade gracefully (empty/fallback string) for unknown tool names.
      return { tool, input };
  }
}
