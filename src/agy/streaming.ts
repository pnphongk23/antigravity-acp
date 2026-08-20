import { buildStreamingAgyArgs, extraArgsFromEnv } from "./process";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const INIT_TIMEOUT_MS = 15_000;
const STDERR_TAIL_LIMIT = 4096;

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: Error) => void;
}

interface PendingTurn extends Deferred<void> {
	timer: ReturnType<typeof setTimeout>;
}

interface StreamResult {
	conversation_id?: string;
	status?: string;
	error?: string;
}

interface StreamEvent {
	event?: string;
	conversation_id?: string;
	result?: StreamResult;
}

export interface StreamingAgyOptions {
	binary: string;
	workingDir: string;
	additionalDirs: string[];
	conversationId: string | null;
	modelId: string | null;
	permissionMode: string | null;
	extraArgs?: string[];
	promptTimeoutMs?: number;
}

/** One native stream-json process bound to one ACP session. */
export class StreamingAgyProcess {
	private child: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
	private ready: Deferred<void> | null = null;
	private pendingTurn: PendingTurn | null = null;
	private stdoutBuffer = "";
	private stderrTail = "";
	private closing = false;
	private turnCancellation: Error | null = null;
	private boundConversationId: string | null;

	constructor(private readonly options: StreamingAgyOptions) {
		this.boundConversationId = options.conversationId;
	}

	get conversationId(): string | null {
		return this.boundConversationId;
	}

	get alive(): boolean {
		return this.child !== null && this.child.exitCode === null && !this.closing;
	}

	isCompatible(options: StreamingAgyOptions): boolean {
		return (
			this.alive &&
			this.options.binary === options.binary &&
			this.options.workingDir === options.workingDir &&
			this.options.modelId === options.modelId &&
			this.options.permissionMode === options.permissionMode &&
			this.boundConversationId === options.conversationId &&
			arrayEquals(this.options.additionalDirs, options.additionalDirs) &&
			arrayEquals(this.options.extraArgs ?? [], options.extraArgs ?? [])
		);
	}

	async start(): Promise<void> {
		if (this.alive && this.ready) return this.ready.promise;
		if (this.closing) throw new Error("agy stream is closing");

		this.ready = deferred<void>();
		const args = buildStreamingAgyArgs({
			workingDir: this.options.workingDir,
			additionalDirs: this.options.additionalDirs,
			conversationId: this.options.conversationId,
			modelId: this.options.modelId,
			permissionMode: this.options.permissionMode,
			extraArgs: this.options.extraArgs ?? extraArgsFromEnv(),
		});

		try {
			this.child = Bun.spawn([this.options.binary, ...args], {
				cwd: this.options.workingDir,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			});
		} catch (error) {
			this.ready = null;
			throw asError(error);
		}

		void this.readStdout(this.child.stdout);
		void this.readStderr(this.child.stderr);
		void this.child.exited.then((code) => this.handleExit(code));

		await withTimeout(
			this.ready.promise,
			INIT_TIMEOUT_MS,
			"agy stream did not emit an init event",
		);
	}

	async runTurn(prompt: string): Promise<void> {
		this.turnCancellation = null;
		await this.start();
		if (this.turnCancellation) {
			const error = this.turnCancellation;
			this.turnCancellation = null;
			throw error;
		}
		if (this.pendingTurn)
			throw new Error("agy stream already has an active turn");
		const child = this.child;
		if (!child || child.exitCode !== null)
			throw new Error("agy stream is unavailable");

		const turn = deferred<void>() as PendingTurn;
		turn.timer = setTimeout(() => {
			const error = new Error("agy stream prompt timed out");
			this.rejectTurn(error);
			this.forceStop();
		}, this.options.promptTimeoutMs ?? promptTimeoutMsFromEnv());
		this.pendingTurn = turn;

		try {
			child.stdin.write(
				`${JSON.stringify({ event: "user", message: { content: prompt } })}\n`,
			);
			child.stdin.flush();
		} catch (error) {
			this.rejectTurn(asError(error));
		}
		return turn.promise;
	}

	cancelTurn(): void {
		const error = new Error("agy stream prompt cancelled");
		this.turnCancellation = error;
		if (this.pendingTurn) this.rejectTurn(error);
		else this.ready?.reject(error);
		this.forceStop();
	}

	async close(): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		this.rejectTurn(new Error("agy stream closed"));
		const child = this.child;
		if (!child) return;

		try {
			child.stdin.end();
		} catch {
			// Process already closed its input.
		}
		await Promise.race([child.exited.then(() => undefined), sleep(300)]);
		if (child.exitCode === null) child.kill();
		this.child = null;
	}

	private async readStdout(stream: ReadableStream<Uint8Array>): Promise<void> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				this.stdoutBuffer += decoder.decode(value, { stream: true });
				this.consumeLines();
			}
			this.stdoutBuffer += decoder.decode();
			this.consumeLines(true);
		} catch (error) {
			this.fail(asError(error));
		} finally {
			reader.releaseLock();
		}
	}

	private async readStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
		const reader = stream.getReader();
		const decoder = new TextDecoder();
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				this.stderrTail = (
					this.stderrTail + decoder.decode(value, { stream: true })
				).slice(-STDERR_TAIL_LIMIT);
			}
		} catch {
			// Exit handling reports the stderr accumulated so far.
		} finally {
			reader.releaseLock();
		}
	}

	private consumeLines(flush = false): void {
		const lines = this.stdoutBuffer.split("\n");
		const tail = lines.pop() ?? "";
		this.stdoutBuffer = flush ? "" : tail;
		for (const line of lines) this.handleLine(line);
		if (flush && tail.trim()) this.handleLine(tail);
	}

	private handleLine(line: string): void {
		if (!line.trim()) return;
		let event: StreamEvent;
		try {
			event = JSON.parse(line) as StreamEvent;
		} catch {
			return;
		}

		if (event.event === "init") {
			this.bindConversation(event.conversation_id);
			this.ready?.resolve(undefined);
			return;
		}
		if (event.event !== "result" || !event.result) return;

		this.bindConversation(
			event.result.conversation_id ?? event.conversation_id,
		);
		if (event.result.status?.toUpperCase() === "ERROR") {
			this.rejectTurn(
				new Error(event.result.error || "agy stream turn failed"),
			);
		} else {
			this.resolveTurn();
		}
	}

	private bindConversation(id: string | undefined): void {
		if (id) this.boundConversationId = id;
	}

	private handleExit(code: number): void {
		if (this.closing) return;
		const detail = this.stderrTail.trim();
		this.fail(
			new Error(
				detail
					? `agy stream exited with status ${code}: ${detail}`
					: `agy stream exited with status ${code}`,
			),
		);
	}

	private fail(error: Error): void {
		this.ready?.reject(error);
		this.rejectTurn(error);
	}

	private resolveTurn(): void {
		const turn = this.pendingTurn;
		if (!turn) return;
		this.pendingTurn = null;
		clearTimeout(turn.timer);
		turn.resolve(undefined);
	}

	private rejectTurn(error: Error): void {
		const turn = this.pendingTurn;
		if (!turn) return;
		this.pendingTurn = null;
		clearTimeout(turn.timer);
		turn.reject(error);
	}

	private forceStop(): void {
		if (this.child?.exitCode === null) this.child.kill();
	}
}

export function persistentAgyEnabled(): boolean {
	return process.env.AGY_PERSISTENT !== "0";
}

export function promptTimeoutMsFromEnv(): number {
	const parsed = Number(process.env.AGY_PROMPT_TIMEOUT_MS);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	message: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function arrayEquals(
	left: readonly string[],
	right: readonly string[],
): boolean {
	return (
		left.length === right.length &&
		left.every((value, index) => value === right[index])
	);
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
