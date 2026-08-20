import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { StepRow } from "../../types";
import {
	asStr,
	codeBlock,
	parseRawInput,
	pick,
	textBlock,
	toolCallUpdate,
	toolKind,
} from "../utils";

/*
  Step type 132 — orchestration tools, each with a distinct argument shape:

  manage_task:      { Action: "status", TaskId: ".../task-30" }
  schedule:         { DurationSeconds: "300", Prompt: "...", TimerCondition: "<id>" }
  send_message:     { Message: "...", Recipient?: "<agent-id>" }
  manage_subagents: { Action: "kill_all" }
  call_mcp_tool:    { ServerName: "paseo", ToolName: "list_profiles", Args?: {...} }
*/

/**
 * Builder for the orchestration tools (step type 132) plus a generic fallback
 * for any other tool without a dedicated handler. Each known tool gets a
 * readable, tool-specific title and content; unknown tools fall back to echoing
 * their meaningful arguments. (Task / permission / error enrichment and status
 * are added downstream by `toolCallUpdate`.)
 */
export function otherUpdate(stepRow: StepRow): SessionUpdate {
	const { stepPayload } = stepRow;
	const toolRun = stepPayload.toolRun;
	const name = toolRun?.call?.namePrimary ?? "";
	const rawInput = parseRawInput(stepRow);

	switch (name) {
		case "manage_task": {
			const action =
				asStr(pick(rawInput, "Action", "action"))?.trim() || "manage";
			const taskId = asStr(pick(rawInput, "TaskId", "taskId"));
			const summary = asStr(
				pick(rawInput, "toolSummary", "ToolSummary"),
			)?.trim();
			const title = summary || `Manage task ${action}`;
			const content = taskId ? [textBlock(`Task: ${taskId}`)] : [];
			return toolCallUpdate({ stepRow, title, kind: "other", content });
		}

		case "call_mcp_tool": {
			const server =
				asStr(pick(rawInput, "ServerName", "serverName", "server"))?.trim() ||
				"";
			const tool =
				asStr(pick(rawInput, "ToolName", "toolName", "tool"))?.trim() || "";
			const title =
				server && tool
					? `MCP ${server}/${tool}`
					: server
						? `MCP ${server}`
						: "Call MCP tool";
			const args = pick(rawInput, "Args", "args", "arguments");
			const content: Record<string, unknown>[] = [];
			if (args != null) {
				content.push(
					codeBlock(
						typeof args === "string" ? args : JSON.stringify(args, null, 2),
					),
				);
			}
			return toolCallUpdate({ stepRow, title, kind: "other", content });
		}

		case "schedule": {
			const duration = asStr(
				pick(rawInput, "DurationSeconds", "durationSeconds"),
			);
			const prompt = asStr(pick(rawInput, "Prompt", "prompt"))?.trim();
			const title = duration
				? `Schedule timer (${duration}s)`
				: "Schedule timer";
			const content = prompt ? [textBlock(prompt)] : [];
			return toolCallUpdate({ stepRow, title, kind: "other", content });
		}

		case "send_message": {
			const message = asStr(pick(rawInput, "Message", "message"))?.trim();
			const title = "Send message to subagent";
			const content = message ? [textBlock(message)] : [];
			return toolCallUpdate({ stepRow, title, kind: "other", content });
		}

		case "manage_subagents": {
			const action =
				asStr(pick(rawInput, "Action", "action"))?.trim() || "manage";
			return toolCallUpdate({
				stepRow,
				title: `Subagents: ${action}`,
				kind: "other",
			});
		}
	}

	// Generic fallback: prefer the human-readable summary, then the generic tool
	// titles, then the raw tool name. (toolAction is often misleading, so it's the
	// last resort.) Echo the meaningful arguments, dropping display-only keys.
	const title =
		asStr(toolRun?.titlePrimary)?.trim() ||
		asStr(pick(rawInput, "toolSummary", "ToolSummary"))?.trim() ||
		asStr(toolRun?.titleSecondary)?.trim() ||
		name ||
		"Tool";

	const content: Record<string, unknown>[] = [];
	if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
		const { toolAction, toolSummary, ...rest } = rawInput as Record<
			string,
			unknown
		>;
		void toolAction;
		void toolSummary;
		if (Object.keys(rest).length > 0) {
			content.push(codeBlock(JSON.stringify(rest, null, 2)));
		}
	}

	return toolCallUpdate({ stepRow, title, kind: toolKind(name), content });
}
