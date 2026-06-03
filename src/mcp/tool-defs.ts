export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
}

export const MCP_TOOL_DEFS: McpToolDef[] = [
  {
    name: "start_session",
    description:
      "Start a new driven Claude Code session in the given cwd. " +
      "Returns session_id + watch_command (a ready-made payload for the Monitor tool; invoke " +
      "Monitor(watch_command) to stream only human-actionable events — approvals, deferrals, completions, errors) " +
      "+ notification_contract (describes the session's vocabulary, surface modes, watch flags, and idle default — " +
      "drivers can read it instead of hardcoding to a specific claw-drive version). " +
      "Optional `wrapper: false` opts out of the sentinel-token wrapper (B doesn't receive the system-prompt " +
      "injection); when set, `notification_contract.wrapper_enabled` is `false`.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        policy: {},
        scenario_brief: { type: "string" },
        name: {
          type: "string",
          description:
            "Optional human-friendly alias for this session, usable in place of the canonical session_id at any session-arg tool. 1-32 chars, starts with a letter, letters/digits/_/- only, must not begin with 'sess_'. Must be unique among live sessions.",
        },
        mcp_extra_config: { type: "object" },
        model: { type: "string" },
        decision_timeout_seconds: { type: "number" },
        wrapper: {
          type: "boolean",
          description:
            "Whether to inject the v0.5.6 sentinel-token contract wrapper into B's system prompt via --append-system-prompt. Default true. Pass false to opt out (raw v0.5.5-style behavior; watch's token filter then has nothing to anchor on, so combine with --no-token-filter).",
        },
      },
      required: ["cwd"],
    },
  },
  {
    name: "stop_session",
    description:
      "Stop a session. Reaps the fresh Claude Code process; keeps the session dir for inspection.",
    inputSchema: {
      type: "object",
      properties: { session_id: { type: "string" } },
      required: ["session_id"],
    },
  },
  {
    name: "send_turn",
    description:
      "Send a user turn to a live session. Non-blocking; returns a turn_id the caller can poll.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        message: { type: "string" },
      },
      required: ["session_id", "message"],
    },
  },
  {
    name: "poll_turn",
    description:
      "Fetch events + derived status for a specific turn. Use wait_ms>0 to long-poll.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        turn_id: { type: "string" },
        since_event: { type: "number" },
        wait_ms: { type: "number" },
      },
      required: ["session_id", "turn_id"],
    },
  },
  {
    name: "poll_session",
    description:
      "Tail events for a session and return current session status. Use wait_ms>0 to long-poll.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        since_event: { type: "number" },
        wait_ms: { type: "number" },
      },
      required: ["session_id"],
    },
  },
  {
    name: "list_sessions",
    description:
      "List sessions on disk (live + orphaned). Orphaned = state.json status is running/ready/starting but runner_pid is dead.",
    inputSchema: {
      type: "object",
      properties: { include_orphaned: { type: "boolean" } },
    },
  },
  {
    name: "resolve_tool_call",
    description:
      "Approve or reject a paused tool call by call_id. Scans live sessions; first session holding the call_id wins. Set remember_as_policy to append the resolved decision as a new Rule.",
    inputSchema: {
      type: "object",
      properties: {
        call_id: { type: "string" },
        action: { enum: ["approve", "reject"] },
        reason: { type: "string" },
        remember_as_policy: { type: "boolean" },
      },
      required: ["call_id", "action", "reason"],
    },
  },
  {
    name: "provide_tool_output",
    description:
      "Provide the output of a deferred command that the human ran manually. " +
      "Injects the output as a new user turn into the driven session B, so B can continue. " +
      "Auto-resolves any still-pending approval as `defer` if needed.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        call_id: { type: "string" },
        stdout: { type: "string" },
        stderr: { type: "string" },
        exit_code: { type: "number" },
        extra: { type: "string" },
      },
      required: ["session_id", "call_id"],
    },
  },
  {
    name: "update_policy",
    description: "Replace a session's permission policy.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        policy: {},
      },
      required: ["session_id", "policy"],
    },
  },
  {
    name: "interrupt_turn",
    description:
      "Send SIGINT to the driven Claude session to interrupt the current turn. Session remains alive.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string" },
        turn_id: { type: "string" },
      },
      required: ["session_id", "turn_id"],
    },
  },
];
