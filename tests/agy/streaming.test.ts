import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
	persistentAgyEnabled,
	StreamingAgyProcess,
} from "../../src/agy/streaming";

interface FakeProcess {
	process: Bun.Subprocess<"pipe", "pipe", "pipe">;
	writes: string[];
	resultStatus: "SUCCESS" | "ERROR" | null;
	killed: boolean;
}

function fakeProcess(): FakeProcess {
	let stdout!: ReadableStreamDefaultController<Uint8Array>;
	let stderr!: ReadableStreamDefaultController<Uint8Array>;
	let resolveExit!: (code: number) => void;
	let exitCode: number | null = null;
	const encoder = new TextEncoder();
	const writes: string[] = [];
	const state = {
		process: undefined as unknown as Bun.Subprocess<"pipe", "pipe", "pipe">,
		writes,
		resultStatus: "SUCCESS" as "SUCCESS" | "ERROR" | null,
		killed: false,
	};
	const stdoutStream = new ReadableStream<Uint8Array>({
		start(controller) {
			stdout = controller;
		},
	});
	const stderrStream = new ReadableStream<Uint8Array>({
		start(controller) {
			stderr = controller;
		},
	});
	const exited = new Promise<number>((resolve) => {
		resolveExit = resolve;
	});
	const finish = (code: number) => {
		if (exitCode !== null) return;
		exitCode = code;
		stdout.close();
		stderr.close();
		resolveExit(code);
	};
	const stdin = {
		write(input: string | Uint8Array) {
			const text =
				typeof input === "string" ? input : new TextDecoder().decode(input);
			writes.push(text);
			if (state.resultStatus) {
				const status = state.resultStatus;
				queueMicrotask(() => {
					stdout.enqueue(
						encoder.encode(
							`${JSON.stringify({
								event: "result",
								result: {
									conversation_id: "conv-1",
									status,
									error: status === "ERROR" ? "turn failed" : undefined,
								},
							})}\n`,
						),
					);
				});
			}
			return text.length;
		},
		flush() {},
		end() {
			finish(0);
		},
	};
	state.process = {
		stdin,
		stdout: stdoutStream,
		stderr: stderrStream,
		exited,
		get exitCode() {
			return exitCode;
		},
		kill() {
			state.killed = true;
			finish(130);
		},
	} as unknown as Bun.Subprocess<"pipe", "pipe", "pipe">;
	stdout.enqueue(
		encoder.encode(
			`${JSON.stringify({ event: "init", conversation_id: "conv-1" })}\n`,
		),
	);
	return state;
}

function options() {
	return {
		binary: "agy",
		workingDir: "/cwd",
		additionalDirs: [],
		conversationId: null,
		modelId: null,
		permissionMode: null,
		promptTimeoutMs: 1000,
	};
}

afterEach(() => {
	mock.restore();
	delete process.env.AGY_PERSISTENT;
});

describe("StreamingAgyProcess", () => {
	test("reuses one process for multiple prompt turns", async () => {
		const fake = fakeProcess();
		const spawn = spyOn(Bun, "spawn").mockReturnValue(fake.process);
		const runtime = new StreamingAgyProcess(options());

		await runtime.runTurn("first");
		await runtime.runTurn("second");

		expect(spawn).toHaveBeenCalledTimes(1);
		expect(runtime.conversationId).toBe("conv-1");
		expect(fake.writes.map((line) => JSON.parse(line))).toEqual([
			{ event: "user", message: { content: "first" } },
			{ event: "user", message: { content: "second" } },
		]);
		await runtime.close();
	});

	test("surfaces an error result", async () => {
		const fake = fakeProcess();
		fake.resultStatus = "ERROR";
		spyOn(Bun, "spawn").mockReturnValue(fake.process);
		const runtime = new StreamingAgyProcess(options());

		await expect(runtime.runTurn("fail")).rejects.toThrow("turn failed");
		await runtime.close();
	});

	test("cancels the active turn by terminating the stream", async () => {
		const fake = fakeProcess();
		fake.resultStatus = null;
		spyOn(Bun, "spawn").mockReturnValue(fake.process);
		const runtime = new StreamingAgyProcess(options());
		await runtime.start();

		const turn = runtime.runTurn("wait");
		await Promise.resolve();
		runtime.cancelTurn();

		await expect(turn).rejects.toThrow("cancelled");
		expect(fake.killed).toBe(true);
	});
});

test("AGY_PERSISTENT=0 selects one-shot compatibility mode", () => {
	process.env.AGY_PERSISTENT = "0";
	expect(persistentAgyEnabled()).toBe(false);
});
