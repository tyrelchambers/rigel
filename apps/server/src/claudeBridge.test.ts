import { test, expect } from "bun:test";
import { mapClaudeEvent } from "./claudeBridge";

// ---------------------------------------------------------------------------
// assistant: tool_use block → tool event
// ---------------------------------------------------------------------------
test("tool_use block produces a tool event with command/description/inputJSON/toolId", () => {
  const ev = {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "tu_abc123",
          name: "Bash",
          input: { command: "kubectl get pods -n default", description: "List pods" },
        },
      ],
    },
  };
  const result = mapClaudeEvent(ev);
  expect(result).toHaveLength(1);
  const [e] = result;
  expect(e.type).toBe("tool");
  expect(e.toolId).toBe("tu_abc123");
  expect(e.toolName).toBe("Bash");
  expect(e.command).toBe("kubectl get pods -n default");
  expect(e.description).toBe("List pods");
  expect(e.inputJSON).toBe(JSON.stringify({ command: "kubectl get pods -n default", description: "List pods" }));
});

test("tool_use block with no command/description still produces a tool event", () => {
  const ev = {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "tu_xyz",
          name: "Read",
          input: { file_path: "/etc/hosts" },
        },
      ],
    },
  };
  const result = mapClaudeEvent(ev);
  expect(result).toHaveLength(1);
  const [e] = result;
  expect(e.type).toBe("tool");
  expect(e.toolId).toBe("tu_xyz");
  expect(e.toolName).toBe("Read");
  expect(e.command).toBeUndefined();
  expect(e.description).toBeUndefined();
  expect(e.inputJSON).toBe(JSON.stringify({ file_path: "/etc/hosts" }));
});

// ---------------------------------------------------------------------------
// user: tool_result (string content, is_error false) → toolResult ok
// ---------------------------------------------------------------------------
test("tool_result with string content and is_error false → toolResult ok", () => {
  const ev = {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_abc123",
          content: "NAME   READY   STATUS\nnginx  1/1     Running",
          is_error: false,
        },
      ],
    },
  };
  const result = mapClaudeEvent(ev);
  expect(result).toHaveLength(1);
  const [e] = result;
  expect(e.type).toBe("toolResult");
  expect(e.toolId).toBe("tu_abc123");
  expect(e.isError).toBe(false);
  expect(e.output).toBe("NAME   READY   STATUS\nnginx  1/1     Running");
});

// ---------------------------------------------------------------------------
// user: tool_result is_error true
// ---------------------------------------------------------------------------
test("tool_result with is_error true → toolResult isError", () => {
  const ev = {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_fail",
          content: "Error from server: pods not found",
          is_error: true,
        },
      ],
    },
  };
  const result = mapClaudeEvent(ev);
  expect(result).toHaveLength(1);
  const [e] = result;
  expect(e.type).toBe("toolResult");
  expect(e.toolId).toBe("tu_fail");
  expect(e.isError).toBe(true);
  expect(e.output).toBe("Error from server: pods not found");
});

// ---------------------------------------------------------------------------
// user: tool_result with array content
// ---------------------------------------------------------------------------
test("tool_result with array content joins text fields", () => {
  const ev = {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_arr",
          content: [{ type: "text", text: "line one" }, { type: "text", text: "line two" }],
          is_error: false,
        },
      ],
    },
  };
  const result = mapClaudeEvent(ev);
  expect(result).toHaveLength(1);
  const [e] = result;
  expect(e.type).toBe("toolResult");
  expect(e.output).toBe("line one\nline two");
  expect(e.isError).toBe(false);
});

// ---------------------------------------------------------------------------
// user: tool_result output truncation at 600 chars
// ---------------------------------------------------------------------------
test("tool_result output is truncated to 600 chars with ellipsis", () => {
  const longOutput = "x".repeat(700);
  const ev = {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "tu_long",
          content: longOutput,
          is_error: false,
        },
      ],
    },
  };
  const result = mapClaudeEvent(ev);
  expect(result).toHaveLength(1);
  const [e] = result;
  expect(e.output).toBe("x".repeat(600) + "…");
});

// ---------------------------------------------------------------------------
// result: permission_denials → toolResult isError "Denied…" then done
// ---------------------------------------------------------------------------
test("result with permission_denials → isError toolResult followed by done", () => {
  const ev = {
    type: "result",
    subtype: "success",
    result: "",
    permission_denials: [
      { tool_name: "Bash", tool_use_id: "tu_denied", tool_input: { command: "kubectl delete pod foo" } },
    ],
  };
  const result = mapClaudeEvent(ev);
  expect(result).toHaveLength(2);
  const [denial, done] = result;
  expect(denial.type).toBe("toolResult");
  expect(denial.toolId).toBe("tu_denied");
  expect(denial.isError).toBe(true);
  expect(denial.output).toContain("Denied");
  expect(done.type).toBe("done");
});

test("result with empty permission_denials → just done", () => {
  const ev = {
    type: "result",
    subtype: "success",
    result: "",
    permission_denials: [],
  };
  const result = mapClaudeEvent(ev);
  expect(result).toHaveLength(1);
  expect(result[0].type).toBe("done");
});

test("result with no permission_denials field → just done", () => {
  const ev = { type: "result", subtype: "success", result: "" };
  const result = mapClaudeEvent(ev);
  expect(result).toHaveLength(1);
  expect(result[0].type).toBe("done");
});

// ---------------------------------------------------------------------------
// assistant: plain text block → text event
// ---------------------------------------------------------------------------
test("plain text assistant block → text event", () => {
  const ev = {
    type: "assistant",
    message: {
      content: [{ type: "text", text: "Here are your pods:" }],
    },
  };
  const result = mapClaudeEvent(ev);
  expect(result).toHaveLength(1);
  expect(result[0]).toEqual({ type: "text", text: "Here are your pods:" });
});

// ---------------------------------------------------------------------------
// assistant: thinking block → thinking event
// ---------------------------------------------------------------------------
test("thinking block → thinking event", () => {
  const ev = {
    type: "assistant",
    message: {
      content: [{ type: "thinking", thinking: "Let me think about this…" }],
    },
  };
  const result = mapClaudeEvent(ev);
  expect(result).toHaveLength(1);
  expect(result[0]).toEqual({ type: "thinking", text: "Let me think about this…" });
});

// ---------------------------------------------------------------------------
// assistant: mixed content → multiple events in order
// ---------------------------------------------------------------------------
test("mixed assistant content → multiple events in order", () => {
  const ev = {
    type: "assistant",
    message: {
      content: [
        { type: "thinking", thinking: "Reasoning…" },
        { type: "text", text: "I will run a command." },
        { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "kubectl get nodes" } },
      ],
    },
  };
  const result = mapClaudeEvent(ev);
  expect(result).toHaveLength(3);
  expect(result[0].type).toBe("thinking");
  expect(result[1].type).toBe("text");
  expect(result[2].type).toBe("tool");
  expect(result[2].command).toBe("kubectl get nodes");
});

// ---------------------------------------------------------------------------
// system init → session event
// ---------------------------------------------------------------------------
test("system init → session event", () => {
  const ev = { type: "system", subtype: "init", session_id: "sess_abc" };
  const result = mapClaudeEvent(ev);
  expect(result).toHaveLength(1);
  expect(result[0]).toEqual({ type: "session", sessionId: "sess_abc" });
});

// ---------------------------------------------------------------------------
// unknown type → empty array
// ---------------------------------------------------------------------------
test("unknown event type → empty array", () => {
  expect(mapClaudeEvent({ type: "unknown_future_type" })).toHaveLength(0);
  expect(mapClaudeEvent(null)).toHaveLength(0);
  expect(mapClaudeEvent({})).toHaveLength(0);
});
