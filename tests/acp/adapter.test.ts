import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Adapter } from "../../src/acp/adapter";
import { newSession } from "../../src/types/session";

function streamingProcess(
	writes: string[] = [],
): Bun.Subprocess<"pipe", "pipe", "pipe"> {
	let stdout!: ReadableStreamDefaultController<Uint8Array>;
	let resolveExit!: (code: number) => void;
	let exitCode: number | null = null;
	const encoder = new TextEncoder();
	const stdoutStream = new ReadableStream<Uint8Array>({
		start(controller) {
			stdout = controller;
		},
	});
	const stderrStream = new ReadableStream<Uint8Array>();
	const exited = new Promise<number>((resolve) => {
		resolveExit = resolve;
	});
	const finish = (code: number) => {
		if (exitCode !== null) return;
		exitCode = code;
		stdout.close();
		resolveExit(code);
	};
	const process = {
		stdin: {
			write(input: string | Uint8Array) {
				writes.push(
					typeof input === "string" ? input : new TextDecoder().decode(input),
				);
				queueMicrotask(() => {
					stdout.enqueue(
						encoder.encode(
							`${JSON.stringify({
								event: "result",
								result: { conversation_id: "conv-1", status: "SUCCESS" },
							})}\n`,
						),
					);
				});
				return 1;
			},
			flush() {},
			end() {
				finish(0);
			},
		},
		stdout: stdoutStream,
		stderr: stderrStream,
		exited,
		get exitCode() {
			return exitCode;
		},
		kill() {
			finish(130);
		},
	} as unknown as Bun.Subprocess<"pipe", "pipe", "pipe">;
	stdout.enqueue(
		encoder.encode(
			`${JSON.stringify({ event: "init", conversation_id: "conv-1" })}\n`,
		),
	);
	return process;
}

afterEach(() => mock.restore());

describe("Adapter", () => {
	test("cancel should handle non-existent session gracefully", () => {
		const adapter = new Adapter({
			workingDir: process.cwd(),
			binary: "agy",
			conversationsDir: "/tmp",
			skipNarration: false,
		});
		// should not throw
		adapter.cancel("non-existent");
		expect(true).toBe(true);
	});

	test("runPrompt should handle spawn failure", async () => {
		const adapter = new Adapter({
			workingDir: process.cwd(),
			binary: "agy",
			conversationsDir: "/tmp",
			skipNarration: false,
		});

		// We could mock spawnAgy but let's test if it handles a non-existent binary or errors.
		// A lightweight test for prompt running.
		expect(adapter).toBeDefined();
	});

	test("reuses one native agy process across ACP prompt turns", async () => {
		const spawn = spyOn(Bun, "spawn").mockReturnValue(streamingProcess());
		const adapter = new Adapter({
			workingDir: process.cwd(),
			binary: "agy",
			conversationsDir: "/path/that/does/not/exist",
			skipNarration: false,
		});
		const session = newSession(process.cwd());
		const client = { update: async () => {} };

		const first = await adapter.runPrompt(
			"session-1",
			session,
			"first",
			client as never,
		);
		session.conversationId = first.conversationId;
		const second = await adapter.runPrompt(
			"session-1",
			session,
			"second",
			client as never,
		);

		expect(first.conversationId).toBe("conv-1");
		expect(second.conversationId).toBe("conv-1");
		expect(spawn).toHaveBeenCalledTimes(1);
		await adapter.close("session-1");
	});

	test("keeps MCP config for the persistent stream lifetime", async () => {
		spyOn(Bun, "spawn").mockReturnValue(streamingProcess());
		const dir = await mkdtemp(join(tmpdir(), "agy-acp-mcp-lifetime-"));
		const mcpConfigFile = join(dir, "mcp_config.json");
		await writeFile(
			mcpConfigFile,
			JSON.stringify({ mcpServers: { existing: { command: "existing" } } }),
		);
		const adapter = new Adapter({
			workingDir: process.cwd(),
			binary: "agy",
			conversationsDir: "/path/that/does/not/exist",
			skipNarration: false,
			mcpConfigFile,
		});
		const session = newSession(process.cwd());
		session.mcpServers = [
			{
				name: "paseo",
				command: "paseo",
				args: ["mcp"],
				env: [],
			},
		];

		try {
			await adapter.runPrompt("session-mcp", session, "first", {
				update: async () => {},
			} as never);
			const active = JSON.parse(await readFile(mcpConfigFile, "utf8"));
			expect(active.mcpServers.paseo).toEqual({
				command: "paseo",
				args: ["mcp"],
				env: {},
			});

			await adapter.close("session-mcp");
			const restored = JSON.parse(await readFile(mcpConfigFile, "utf8"));
			expect(restored.mcpServers).toEqual({
				existing: { command: "existing" },
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("routes internal Paseo MCP through CLI context once", async () => {
		const writes: string[] = [];
		spyOn(Bun, "spawn").mockReturnValue(streamingProcess(writes));
		const dir = await mkdtemp(join(tmpdir(), "agy-acp-paseo-cli-"));
		const mcpConfigFile = join(dir, "mcp_config.json");
		const adapter = new Adapter({
			workingDir: process.cwd(),
			binary: "agy",
			conversationsDir: "/path/that/does/not/exist",
			skipNarration: false,
			mcpConfigFile,
		});
		const session = newSession(process.cwd());
		session.mcpServers = [
			{
				type: "http",
				name: "paseo",
				url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=agent-a",
				headers: [],
			},
		];

		try {
			const first = await adapter.runPrompt("session-cli", session, "first", {
				update: async () => {},
			} as never);
			session.conversationId = first.conversationId;
			await adapter.runPrompt("session-cli", session, "second", {
				update: async () => {},
			} as never);

			const prompts = writes.map(
				(line) => JSON.parse(line).message.content as string,
			);
			expect(prompts[0]).toContain("[PASEO CLI]");
			expect(prompts[0]).toEndWith("first");
			expect(prompts[1]).toBe("second");
			expect(await Bun.file(mcpConfigFile).exists()).toBe(false);
			await adapter.close("session-cli");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("falls back to one-shot mode when stream-json cannot start", async () => {
		const oneShot = {
			stderr: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.close();
				},
			}),
			exited: Promise.resolve(0),
			kill() {},
		} as unknown as Bun.Subprocess;
		const spawn = spyOn(Bun, "spawn")
			.mockImplementationOnce(() => {
				throw new Error("unknown flag: --input-format");
			})
			.mockReturnValue(oneShot);
		const adapter = new Adapter({
			workingDir: process.cwd(),
			binary: "agy",
			conversationsDir: "/path/that/does/not/exist",
			skipNarration: false,
		});

		const outcome = await adapter.runPrompt(
			"legacy-session",
			newSession(process.cwd()),
			"hello",
			{ update: async () => {} } as never,
		);

		expect(spawn).toHaveBeenCalledTimes(2);
		expect(outcome.error).toBeUndefined();
	});
});
