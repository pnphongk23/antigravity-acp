// Prompt-turn runtime: keep one native agy stream per ACP session, poll its DB
// for updates, and retain one-shot mode as a compatibility fallback.

import { McpConfigOverlay } from "../agy/mcp";
import { hasPaseoAgentMcpServer, PASEO_CLI_CONTEXT } from "../agy/paseo-cli";
import { buildAgyArgs, extraArgsFromEnv, spawnAgy } from "../agy/process";
import {
	persistentAgyEnabled,
	type StreamingAgyOptions,
	StreamingAgyProcess,
} from "../agy/streaming";
import { POLL_INTERVAL_MS } from "../constants";
import { conversationSnapshot } from "../conversation/scan";
import { StreamPoller } from "../conversation/streaming";
import type { Session } from "../types/session";
import type { AcpClient } from "./client";

const sleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface PromptOutcome {
	stopReason: "end_turn" | "cancelled";
	conversationId: string | null;
	lastStepIdx: number;
	hadUpdates: boolean;
	error?: string;
}

export interface AdapterConfig {
	binary: string;
	conversationsDir: string;
	workingDir: string;
	skipNarration: boolean;
	mcpConfigFile?: string;
}

interface StreamEntry {
	runtime: StreamingAgyProcess;
	mcpFingerprint: string;
	restoreMcp: () => Promise<void>;
}

export class Adapter {
	private readonly oneShotChildren = new Map<string, Bun.Subprocess>();
	private readonly streams = new Map<string, StreamEntry>();
	private readonly cancelled = new Set<string>();
	private readonly inFlight = new Set<string>();
	private readonly paseoCliIntroduced = new Set<string>();
	private readonly mcpOverlay: McpConfigOverlay;

	constructor(private readonly config: AdapterConfig) {
		this.mcpOverlay = new McpConfigOverlay(config.mcpConfigFile);
	}

	cancel(sessionId: string): void {
		this.cancelled.add(sessionId);
		this.streams.get(sessionId)?.runtime.cancelTurn();
		const child = this.oneShotChildren.get(sessionId);
		if (!child) return;
		if (process.platform === "win32") child.kill();
		else child.kill("SIGINT");
	}

	async close(sessionId: string): Promise<void> {
		this.cancel(sessionId);
		const entry = this.streams.get(sessionId);
		this.streams.delete(sessionId);
		if (entry) await this.disposeStream(entry);
		this.cancelled.delete(sessionId);
		this.paseoCliIntroduced.delete(sessionId);
	}

	async runPrompt(
		sessionId: string,
		session: Session,
		promptText: string,
		client: AcpClient,
	): Promise<PromptOutcome> {
		if (this.inFlight.has(sessionId)) {
			return this.errorOutcome(
				session,
				"a prompt is already running for this session",
			);
		}

		this.inFlight.add(sessionId);
		this.cancelled.delete(sessionId);
		const effectivePrompt = this.withPaseoCliContext(
			sessionId,
			session,
			promptText,
		);
		try {
			if (persistentAgyEnabled()) {
				const snapshot =
					session.conversationId === null
						? conversationSnapshot(this.config.conversationsDir)
						: null;
				const runtime = await this.prepareStream(sessionId, session);
				if (runtime) {
					return await this.runStreamingPrompt(
						sessionId,
						session,
						effectivePrompt,
						client,
						runtime,
						snapshot,
					);
				}
			}
			return await this.runOneShotPrompt(
				sessionId,
				session,
				effectivePrompt,
				client,
			);
		} finally {
			this.inFlight.delete(sessionId);
		}
	}

	private withPaseoCliContext(
		sessionId: string,
		session: Session,
		promptText: string,
	): string {
		if (
			this.paseoCliIntroduced.has(sessionId) ||
			!hasPaseoAgentMcpServer(session.mcpServers)
		) {
			return promptText;
		}
		this.paseoCliIntroduced.add(sessionId);
		return `${PASEO_CLI_CONTEXT}\n\n${promptText}`;
	}

	private async prepareStream(
		sessionId: string,
		session: Session,
	): Promise<StreamingAgyProcess | null> {
		const options = this.streamOptions(session);
		const mcpFingerprint = JSON.stringify(session.mcpServers);
		let entry = this.streams.get(sessionId);
		if (
			entry &&
			(!entry.runtime.isCompatible(options) ||
				entry.mcpFingerprint !== mcpFingerprint)
		) {
			await this.disposeStream(entry);
			this.streams.delete(sessionId);
			entry = undefined;
		}
		if (entry) return entry.runtime;

		const runtime = new StreamingAgyProcess(options);
		const restoreMcp = await this.mcpOverlay.apply(session.mcpServers);
		try {
			await runtime.start();
			this.streams.set(sessionId, {
				runtime,
				mcpFingerprint,
				restoreMcp,
			});
			return runtime;
		} catch (error) {
			console.error(
				`[agy-acp] stream-json unavailable, using one-shot mode: ${(error as Error).message}`,
			);
			await runtime.close();
			await restoreMcp();
			return null;
		}
	}

	private async runStreamingPrompt(
		sessionId: string,
		session: Session,
		promptText: string,
		client: AcpClient,
		runtime: StreamingAgyProcess,
		snapshot: Set<string> | null,
	): Promise<PromptOutcome> {
		const poller = this.createPoller(session, runtime.conversationId, snapshot);
		try {
			await this.streamUntil(
				sessionId,
				client,
				poller,
				runtime.runTurn(promptText),
			);
		} catch (error) {
			const entry = this.streams.get(sessionId);
			if (entry) {
				this.streams.delete(sessionId);
				await this.disposeStream(entry);
			} else {
				await runtime.close();
			}
			const wasCancelled = this.cancelled.delete(sessionId);
			const outcome = this.pollerOutcome(session, poller, wasCancelled);
			if (!wasCancelled && !poller.hadUpdates) {
				outcome.error = `agy failed: ${(error as Error).message}`;
			}
			return outcome;
		}

		const wasCancelled = this.cancelled.delete(sessionId);
		return this.pollerOutcome(session, poller, wasCancelled);
	}

	private async disposeStream(entry: StreamEntry): Promise<void> {
		try {
			await entry.runtime.close();
		} finally {
			await entry.restoreMcp();
		}
	}

	private async runOneShotPrompt(
		sessionId: string,
		session: Session,
		promptText: string,
		client: AcpClient,
	): Promise<PromptOutcome> {
		const effectiveCwd = session.cwd || this.config.workingDir;
		const snapshot =
			session.conversationId === null
				? conversationSnapshot(this.config.conversationsDir)
				: null;
		const args = buildAgyArgs({
			workingDir: effectiveCwd,
			additionalDirs: session.additionalDirs,
			conversationId: session.conversationId,
			modelId: session.modelId,
			permissionMode: session.permissionMode,
			prompt: promptText,
			extraArgs: extraArgsFromEnv(),
		});
		const restoreMcp = await this.mcpOverlay.apply(session.mcpServers);

		try {
			let child: Bun.Subprocess;
			try {
				child = spawnAgy(this.config.binary, args, effectiveCwd);
			} catch (error) {
				return this.errorOutcome(
					session,
					`failed to run agy: ${(error as Error).message}`,
				);
			}
			this.oneShotChildren.set(sessionId, child);
			const stderrPromise = child.stderr
				? new Response(child.stderr as ReadableStream).text()
				: Promise.resolve("");
			const poller = this.createPoller(
				session,
				session.conversationId,
				snapshot,
			);
			const exitCode = await this.streamUntil(
				sessionId,
				client,
				poller,
				child.exited,
			);
			this.oneShotChildren.delete(sessionId);

			const stderr = (await stderrPromise).trim();
			if (stderr) console.error(`[agy-acp] agy stderr: ${stderr}`);
			const wasCancelled = this.cancelled.delete(sessionId);
			const outcome = this.pollerOutcome(session, poller, wasCancelled);
			if (!wasCancelled && exitCode !== 0 && !poller.hadUpdates) {
				outcome.error = stderr || `agy exited with status: ${exitCode}`;
			}
			return outcome;
		} finally {
			await restoreMcp();
		}
	}

	private streamOptions(session: Session): StreamingAgyOptions {
		return {
			binary: this.config.binary,
			workingDir: session.cwd || this.config.workingDir,
			additionalDirs: session.additionalDirs,
			conversationId: session.conversationId,
			modelId: session.modelId,
			permissionMode: session.permissionMode,
			extraArgs: extraArgsFromEnv(),
		};
	}

	private createPoller(
		session: Session,
		conversationId: string | null,
		snapshot: Set<string> | null,
	): StreamPoller {
		return new StreamPoller({
			dir: this.config.conversationsDir,
			conversationId,
			baseStepIdx: session.lastStepIdx,
			skipNarration: this.config.skipNarration,
			cwd: session.cwd || this.config.workingDir,
			snapshot,
		});
	}

	private async streamUntil<T>(
		sessionId: string,
		client: AcpClient,
		poller: StreamPoller,
		completion: Promise<T>,
	): Promise<T> {
		const pollOnce = async () => {
			for (const update of poller.poll())
				await client.update(sessionId, update);
		};
		let polling = true;
		const loop = (async () => {
			while (polling) {
				try {
					await pollOnce();
				} catch (error) {
					console.error(`[agy-acp] poll error: ${(error as Error).message}`);
				}
				if (polling) await sleep(POLL_INTERVAL_MS);
			}
		})();

		let result: T | undefined;
		let failure: unknown;
		try {
			result = await completion;
		} catch (error) {
			failure = error;
		}
		polling = false;
		await loop;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				await pollOnce();
			} catch (error) {
				console.error(
					`[agy-acp] final poll error: ${(error as Error).message}`,
				);
			}
			if (attempt < 2) await sleep(100);
		}
		poller.close();
		if (failure) throw failure;
		return result as T;
	}

	private pollerOutcome(
		session: Session,
		poller: StreamPoller,
		wasCancelled: boolean,
	): PromptOutcome {
		return {
			stopReason: wasCancelled ? "cancelled" : "end_turn",
			conversationId: poller.conversationId ?? session.conversationId,
			lastStepIdx: poller.lastStepIdx,
			hadUpdates: poller.hadUpdates,
		};
	}

	private errorOutcome(session: Session, error: string): PromptOutcome {
		return {
			stopReason: "end_turn",
			conversationId: session.conversationId,
			lastStepIdx: session.lastStepIdx,
			hadUpdates: false,
			error,
		};
	}
}
