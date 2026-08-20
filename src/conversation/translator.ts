// Shared step → ACP update engine for both live streaming and history replay.
//
// Streaming and replay only really differ in how they treat the agent's text
// stream (step type 15):
//
//   • streaming emits the newly-appended slice each poll (text grows in place
//     at a fixed idx), deduping tool steps it has already sent;
//   • replay buffers consecutive agent-text parts and flushes them as one
//     message at each boundary, applying narration filtering across the group.
//
// Everything else — tool calls, titles, user prompts, and the task/permission/
// error enrichment — is identical, so it flows through the same per-step
// dispatcher (`buildUpdatefromStepPayload`). This class owns the one row loop;
// the two modes are just small branches inside it.

import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { filterNarration, isNarration } from "../narration";
import type { StepRow } from "../types";
import { toolCallId } from "../updates/utils";
import { buildUpdatefromStepPayload } from "./updates";

export type TranslateMode = "stream" | "replay";

export interface TranslatorOptions {
	mode: TranslateMode;
	skipNarration: boolean;
	/** Project working dir, used to render display paths in tool calls. */
	cwd?: string;
}

function agentChunk(text: string): SessionUpdate {
	return {
		sessionUpdate: "agent_message_chunk",
		content: { type: "text", text },
	};
}

function thoughtChunk(text: string): SessionUpdate {
	return {
		sessionUpdate: "agent_thought_chunk",
		content: { type: "text", text },
	};
}

export class Translator {
	// Streaming: idx -> chars of agent text already emitted (for incremental diff).
	private readonly agentTextLengths = new Map<number, number>();
	private readonly agentThoughtLengths = new Map<number, number>();
	// Streaming: tool step indices already emitted (dedup across polls).
	private readonly emittedSteps = new Set<number>();
	// Streaming: last fingerprint per idx so status/output changes re-emit.
	private readonly emittedFingerprints = new Map<number, string>();
	// Replay: buffered consecutive agent-text parts, flushed at boundaries.
	private readonly pendingAgentParts: string[] = [];
	private readonly pendingThoughtParts: string[] = [];

	private _lastTitle: string | null = null;
	private _lastStepIdx = -1;
	private _hadUpdates = false;

	constructor(private readonly opts: TranslatorOptions) {}

	/** Highest step idx seen so far. */
	get lastStepIdx(): number {
		return this._lastStepIdx;
	}

	/** Whether any update has been produced across all batches. */
	get hadUpdates(): boolean {
		return this._hadUpdates;
	}

	/** Translate a batch of rows into ordered ACP updates, advancing state. */
	translate(rows: StepRow[]): SessionUpdate[] {
		const out: SessionUpdate[] = [];
		for (const row of rows) this.translateRow(row, out);
		// Replay groups agent text per batch; a batch ends a message boundary.
		if (this.opts.mode === "replay") this.flushAgentBuffer(out);
		if (out.length > 0) this._hadUpdates = true;
		return out;
	}

	private translateRow(row: StepRow, out: SessionUpdate[]): void {
		this._lastStepIdx = Math.max(this._lastStepIdx, row.idx);

		switch (row.stepType) {
			case 15: // agent text chunk
				this.handleAgentText(row, out);
				return;

			case 23: // conversation title
				this.handleTitle(row, out);
				return;

			case 14: // user prompt
				// The streaming client already has its own prompt; only replay re-emits it.
				if (this.opts.mode === "stream") return;
				this.flushAgentBuffer(out);
				this.pushDispatched(row, out);
				return;

			default: {
				// Tool calls and lifecycle steps. In replay, a tool call ends the
				// current agent message; in streaming, dedup by idx across polls
				// unless the step's status or output changed (then emit
				// tool_call_update so the UI leaves in_progress).
				if (this.opts.mode === "replay") {
					this.flushAgentBuffer(out);
				} else if (this.emittedSteps.has(row.idx)) {
					const fp = stepFingerprint(row);
					if (this.emittedFingerprints.get(row.idx) === fp) return;
					this.emittedFingerprints.set(row.idx, fp);
					this.pushDispatched(row, out, true);
					return;
				}
				this.emittedSteps.add(row.idx);
				this.emittedFingerprints.set(row.idx, stepFingerprint(row));
				this.pushDispatched(row, out);
			}
		}
	}

	private pushDispatched(
		row: StepRow,
		out: SessionUpdate[],
		asUpdate = false,
	): void {
		const update = buildUpdatefromStepPayload(row, this.opts.cwd);
		if (Array.isArray(update)) {
			for (const item of update) {
				out.push(asUpdate ? asToolCallUpdate(item) : item);
			}
		} else if (update) {
			out.push(asUpdate ? asToolCallUpdate(update) : update);
		}
	}

	private handleTitle(row: StepRow, out: SessionUpdate[]): void {
		const title = row.stepPayload.titleUpdate?.title ?? null;
		const blocks = title?.split("\n\n");
		const currentTitle = blocks?.shift() || null;
		if (currentTitle !== this._lastTitle) {
			this._lastTitle = currentTitle;
			out.push({ sessionUpdate: "session_info_update", title: currentTitle });
		}

		if (!blocks || blocks?.filter((b) => b.trim().length > 0).length === 0)
			return;

		out.push({
			sessionUpdate: "tool_call",
			toolCallId: toolCallId(row),
			title: "Think",
			kind: "think",
			status: "completed",
			content: [
				{
					type: "content",
					content: {
						type: "text",
						text: blocks?.join("\n\n") || (currentTitle ?? ""),
					},
				},
			],
		});
		return;
	}

	private handleAgentText(row: StepRow, out: SessionUpdate[]): void {
		const text = row.stepPayload.agentText?.text ?? "";
		const thought = row.stepPayload.agentText?.thought ?? "";

		if (this.opts.mode === "replay") {
			if (thought.length > 0) this.pendingThoughtParts.push(thought);
			if (text.length > 0) this.pendingAgentParts.push(text);
			return;
		}

		this.emitStreamDelta(
			out,
			this.agentThoughtLengths,
			row.idx,
			thought,
			thoughtChunk,
			false,
		);
		this.emitStreamDelta(
			out,
			this.agentTextLengths,
			row.idx,
			text,
			agentChunk,
			this.opts.skipNarration,
		);
	}

	private emitStreamDelta(
		out: SessionUpdate[],
		lengths: Map<number, number>,
		idx: number,
		value: string,
		chunk: (delta: string) => SessionUpdate,
		filter: boolean,
	): void {
		const emitted = lengths.get(idx) ?? 0;
		if (value.length <= emitted) return;
		lengths.set(idx, value.length);
		if (filter && isNarration(value)) return;
		const delta = value.slice(emitted);
		if (delta.length > 0) out.push(chunk(delta));
	}

	private flushAgentBuffer(out: SessionUpdate[]): void {
		if (this.pendingThoughtParts.length > 0) {
			const thought = this.pendingThoughtParts.join("\n");
			this.pendingThoughtParts.length = 0;
			if (thought.length > 0) out.push(thoughtChunk(thought));
		}
		if (this.pendingAgentParts.length === 0) return;
		const text = this.opts.skipNarration
			? filterNarration(this.pendingAgentParts)
			: this.pendingAgentParts.join("\n");
		this.pendingAgentParts.length = 0;
		if (text && text.length > 0) out.push(agentChunk(text));
	}
}

/** Stable fingerprint of the fields that should trigger a tool_call_update. */
function stepFingerprint(row: StepRow): string {
	return JSON.stringify({
		s: row.status,
		e: row.error?.message ?? "",
		d: row.error?.detail ?? "",
		t: row.task?.logUri ?? "",
		i: row.task?.taskId ?? "",
		x: row.task?.description ?? "",
	});
}

function asToolCallUpdate(update: SessionUpdate): SessionUpdate {
	if (update.sessionUpdate === "tool_call") {
		return { ...update, sessionUpdate: "tool_call_update" };
	}
	return update;
}
