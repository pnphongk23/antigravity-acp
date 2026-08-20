// Translate ACP `mcpServers` into agy's `mcp_config.json` and overlay them for
// the duration of a spawn. agy has no `--mcp-config` flag, so the only way to
// inject Paseo (or any other client-supplied MCP) is to write the global
// config file, then restore it when the process exits.
//
// Concurrent overlays of the same server name are stacked: restoring an inner
// frame reveals the previous overlay instead of wiping a still-running prompt.

import * as fs from "node:fs";
import * as path from "node:path";
import type { McpServer } from "@agentclientprotocol/sdk";
import { AGY_MCP_CONFIG_FILE } from "../constants";

const ABSENT = Symbol("absent");

type AgyServer = Record<string, unknown>;

interface AgyMcpConfig {
	mcpServers: Record<string, AgyServer>;
	[key: string]: unknown;
}

interface StackFrame {
	id: number;
	value: AgyServer | typeof ABSENT;
}

type HeaderEntry = { name?: unknown; value?: unknown };

/** Convert ACP mcpServers into agy's `{ mcpServers: { name: {...} } }` entries. */
export function toAgyMcpServers(
	servers: readonly McpServer[] | undefined | null,
): Record<string, AgyServer> {
	const out: Record<string, AgyServer> = {};
	if (!servers) return out;

	for (const raw of servers) {
		const s = raw as McpServer & { type?: string; url?: string };
		const name = typeof s.name === "string" ? s.name.trim() : "";
		if (!name) continue;

		if (s.type === "acp") continue;

		if (s.type === "http" || s.type === "sse") {
			const url = typeof s.url === "string" ? s.url.trim() : "";
			if (!url) continue;
			const headers = headersToObject((s as { headers?: unknown }).headers);
			out[name] = {
				serverUrl: url,
				...(Object.keys(headers).length > 0 ? { headers } : {}),
			};
			continue;
		}

		const command =
			typeof (s as { command?: unknown }).command === "string"
				? (s as { command: string }).command.trim()
				: "";
		if (!command) continue;
		const stdio = s as { args?: unknown; env?: unknown };
		out[name] = {
			command,
			args: Array.isArray(stdio.args)
				? stdio.args.filter((a): a is string => typeof a === "string")
				: [],
			env: envToObject(stdio.env),
		};
	}
	return out;
}

function headersToObject(headers: unknown): Record<string, string> {
	return namedValuesToObject(headers);
}

function envToObject(env: unknown): Record<string, string> {
	return namedValuesToObject(env);
}

function namedValuesToObject(value: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (Array.isArray(value)) {
		for (const entry of value as HeaderEntry[]) {
			if (typeof entry?.name === "string" && typeof entry.value === "string") {
				out[entry.name] = entry.value;
			}
		}
		return out;
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (typeof v === "string") out[k] = v;
		}
	}
	return out;
}

export class McpConfigOverlay {
	private writeChain: Promise<void> = Promise.resolve();
	private nextId = 1;
	private readonly stacks = new Map<string, StackFrame[]>();
	private createdFile = false;
	private readonly file: string;

	constructor(file: string = AGY_MCP_CONFIG_FILE) {
		this.file = file || AGY_MCP_CONFIG_FILE;
	}

	/** Overlay ACP servers onto agy's config. The returned function restores
	 *  this overlay's keys (safe to call more than once). */
	async apply(
		servers: readonly McpServer[] | undefined | null,
	): Promise<() => Promise<void>> {
		const overlay = toAgyMcpServers(servers);
		const keys = Object.keys(overlay);
		if (keys.length === 0) return async () => {};

		const id = this.nextId++;
		await this.run(() => this.applyLocked(id, overlay, keys));

		let restored = false;
		return async () => {
			if (restored) return;
			restored = true;
			await this.run(() => this.restoreLocked(id, keys));
		};
	}

	private applyLocked(
		id: number,
		overlay: Record<string, AgyServer>,
		keys: string[],
	): void {
		const doc = this.readDoc();
		if (!doc) {
			console.error(
				"[agy-acp] WARN: mcp_config.json is invalid JSON; skipping MCP overlay",
			);
			return;
		}
		for (const key of keys) {
			const next = overlay[key];
			if (next === undefined) continue;
			let stack = this.stacks.get(key);
			if (!stack) {
				const previous =
					key in doc.mcpServers ? (doc.mcpServers[key] ?? ABSENT) : ABSENT;
				stack = [{ id: 0, value: previous }];
				this.stacks.set(key, stack);
			}
			stack.push({ id, value: next });
			doc.mcpServers[key] = next;
		}
		this.writeDoc(doc);
		console.error(
			`[agy-acp] forwarding ${keys.length} MCP server(s) to agy: ${keys.join(", ")}`,
		);
	}

	private restoreLocked(id: number, keys: string[]): void {
		const doc = this.readDoc();
		if (!doc) return;
		for (const key of keys) {
			const stack = this.stacks.get(key);
			if (!stack) continue;
			const idx = stack.findIndex((frame) => frame.id === id);
			if (idx === -1) continue;
			stack.splice(idx, 1);
			const top = stack[stack.length - 1];
			if (!top || top.id === 0) {
				this.stacks.delete(key);
				if (!top || top.value === ABSENT) delete doc.mcpServers[key];
				else doc.mcpServers[key] = top.value;
			} else if (top.value !== ABSENT) {
				doc.mcpServers[key] = top.value;
			} else {
				delete doc.mcpServers[key];
			}
		}
		this.writeDoc(doc);
	}

	private readDoc(): AgyMcpConfig | null {
		if (!fs.existsSync(this.file)) {
			this.createdFile = true;
			return { mcpServers: {} };
		}
		try {
			const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				return null;
			}
			const doc = parsed as AgyMcpConfig;
			if (
				!doc.mcpServers ||
				typeof doc.mcpServers !== "object" ||
				Array.isArray(doc.mcpServers)
			) {
				doc.mcpServers = {};
			}
			return doc;
		} catch {
			return null;
		}
	}

	private writeDoc(doc: AgyMcpConfig): void {
		const empty =
			Object.keys(doc.mcpServers).length === 0 && this.stacks.size === 0;
		if (empty && this.createdFile) {
			try {
				fs.unlinkSync(this.file);
			} catch {
				// ignore
			}
			this.createdFile = false;
			return;
		}
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		const tmp = `${this.file}.tmp`;
		fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
		fs.renameSync(tmp, this.file);
	}

	private run(fn: () => void): Promise<void> {
		const task = this.writeChain.then(fn);
		this.writeChain = task.catch((err) => {
			console.error(
				`[agy-acp] WARN: MCP overlay failed: ${(err as Error).message}`,
			);
		});
		return task;
	}
}
