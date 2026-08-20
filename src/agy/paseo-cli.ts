import type { McpServer } from "@agentclientprotocol/sdk";

const PASEO_SERVER_NAME = "paseo";
const PASEO_AGENT_MCP_PATH = "/mcp/agents";

type HttpMcpServer = McpServer & {
	type?: string;
	url?: string;
};

/** True only for Paseo's per-agent MCP endpoint, not arbitrary servers named paseo. */
export function isPaseoAgentMcpServer(server: McpServer): boolean {
	const candidate = server as HttpMcpServer;
	if (
		candidate.name !== PASEO_SERVER_NAME ||
		(candidate.type !== "http" && candidate.type !== "sse") ||
		typeof candidate.url !== "string"
	) {
		return false;
	}

	try {
		return new URL(candidate.url).pathname === PASEO_AGENT_MCP_PATH;
	} catch {
		return false;
	}
}

export function hasPaseoAgentMcpServer(
	servers: readonly McpServer[] | undefined | null,
): boolean {
	return servers?.some(isPaseoAgentMcpServer) ?? false;
}

export const PASEO_CLI_CONTEXT = `<system>
[PASEO CLI] Paseo orchestration is available through the \`paseo\` shell command instead of MCP tools. The host already sets PASEO_AGENT_ID and PASEO_AGENT_CWD; never override or unset them. Use \`paseo --help\` for discovery and JSON output for automation. Use \`paseo run --background ...\` for non-blocking delegation; an agent-scoped run automatically keeps caller parentage and workspace unless explicitly placed elsewhere. Obey the current session mode and permission constraints, and never restart the Paseo daemon unless the user explicitly asks.
</system>`;
