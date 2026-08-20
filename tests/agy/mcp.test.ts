import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import { McpConfigOverlay, toAgyMcpServers } from "../../src/agy/mcp";

describe("toAgyMcpServers()", () => {
	test("converts ACP HTTP servers to agy serverUrl + headers object", () => {
		const servers = [
			{
				type: "http",
				name: "paseo",
				url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=abc",
				headers: [{ name: "Authorization", value: "Bearer secret" }],
			},
		] as McpServer[];

		expect(toAgyMcpServers(servers)).toEqual({
			paseo: {
				serverUrl: "http://127.0.0.1:6767/mcp/agents?callerAgentId=abc",
				headers: { Authorization: "Bearer secret" },
			},
		});
	});

	test("converts stdio servers and skips acp-type servers", () => {
		const servers = [
			{
				name: "gitnexus",
				command: "gitnexus-mcp",
				args: ["serve"],
				env: [{ name: "FOO", value: "bar" }],
			},
			{
				type: "acp",
				name: "experimental",
				command: "ignored",
				args: [],
				env: [],
			},
		] as McpServer[];

		expect(toAgyMcpServers(servers)).toEqual({
			gitnexus: {
				command: "gitnexus-mcp",
				args: ["serve"],
				env: { FOO: "bar" },
			},
		});
	});

	test("returns empty object for missing or nameless servers", () => {
		expect(toAgyMcpServers(undefined)).toEqual({});
		expect(toAgyMcpServers([])).toEqual({});
		expect(
			toAgyMcpServers([
				{ type: "http", name: "", url: "http://x", headers: [] },
			] as McpServer[]),
		).toEqual({});
	});
});

describe("McpConfigOverlay", () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-mcp-"));
	const file = path.join(tempDir, "mcp_config.json");

	afterEach(() => {
		if (fs.existsSync(file)) fs.unlinkSync(file);
		const tmp = `${file}.tmp`;
		if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
	});

	test("overlays HTTP servers then restores the original file", async () => {
		const original = {
			mcpServers: {
				axiom: { command: "axiom-mcp", args: [], env: {} },
			},
		};
		fs.writeFileSync(file, JSON.stringify(original, null, 2));

		const overlay = new McpConfigOverlay(file);
		const restore = await overlay.apply([
			{
				type: "http",
				name: "paseo",
				url: "http://127.0.0.1:6767/mcp",
				headers: [{ name: "Authorization", value: "Bearer t" }],
			},
		] as McpServer[]);

		const during = JSON.parse(fs.readFileSync(file, "utf8"));
		expect(during.mcpServers.axiom).toEqual(original.mcpServers.axiom);
		expect(during.mcpServers.paseo).toEqual({
			serverUrl: "http://127.0.0.1:6767/mcp",
			headers: { Authorization: "Bearer t" },
		});

		await restore();
		const after = JSON.parse(fs.readFileSync(file, "utf8"));
		expect(after).toEqual(original);
	});

	test("nested overlays restore the inner frame first", async () => {
		fs.writeFileSync(file, JSON.stringify({ mcpServers: {} }));
		const overlay = new McpConfigOverlay(file);

		const restoreA = await overlay.apply([
			{
				type: "http",
				name: "paseo",
				url: "http://a.example/mcp",
				headers: [],
			},
		] as McpServer[]);
		const restoreB = await overlay.apply([
			{
				type: "http",
				name: "paseo",
				url: "http://b.example/mcp",
				headers: [],
			},
		] as McpServer[]);

		expect(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.paseo.serverUrl).toBe(
			"http://b.example/mcp",
		);

		await restoreA();
		expect(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.paseo.serverUrl).toBe(
			"http://b.example/mcp",
		);

		await restoreB();
		expect(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.paseo).toBeUndefined();
	});

	test("deletes a file it created when the overlay restores", async () => {
		const overlay = new McpConfigOverlay(file);
		expect(fs.existsSync(file)).toBe(false);
		const restore = await overlay.apply([
			{
				type: "http",
				name: "paseo",
				url: "http://127.0.0.1:6767/mcp",
				headers: [],
			},
		] as McpServer[]);
		expect(fs.existsSync(file)).toBe(true);
		await restore();
		expect(fs.existsSync(file)).toBe(false);
	});
});
