import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as sdk from "@agentclientprotocol/sdk";
import { runAcp } from "../../src/acp/server";
import * as processUtils from "../../src/agy/process";

describe("runAcp", () => {
	afterEach(() => {
		mock.restore();
	});

	test("should map Bun.stdin and Bun.stdout to ndJsonStream", async () => {
		let ndJsonStreamArgs: any[] = [];

		// Spy on SDK methods instead of mock.module
		spyOn(sdk, "ndJsonStream").mockImplementation(((...args: any[]) => {
			ndJsonStreamArgs = args;
			return "mocked_stream" as any;
		}) as any);

		const requestMethods: unknown[] = [];
		const agentBuilder = {
			onRequest: (method: unknown) => {
				requestMethods.push(method);
				return agentBuilder;
			},
			onNotification: () => agentBuilder,
			connect: (_stream: any) => {
				return { closed: Promise.resolve() };
			},
		};
		spyOn(sdk, "agent").mockReturnValue(agentBuilder as any);

		// Spy on discoverModels to prevent real background processes
		spyOn(processUtils, "discoverModels").mockResolvedValue([]);

		// Spy on Bun.stdin/stdout methods
		let writerWritten = false;
		let writerClosed = false;
		const mockWriter = {
			write: () => {
				writerWritten = true;
			},
			flush: () => {},
			end: () => {
				writerClosed = true;
			},
		};

		const stdinSpy = spyOn(Bun.stdin, "stream").mockReturnValue(
			"mocked_stdin_stream" as any,
		);
		const stdoutSpy = spyOn(Bun.stdout, "writer").mockReturnValue(
			mockWriter as any,
		);

		runAcp();

		expect(stdinSpy).toHaveBeenCalled();
		expect(stdoutSpy).toHaveBeenCalled();

		expect(ndJsonStreamArgs.length).toBe(2);
		expect(ndJsonStreamArgs[1]).toBe("mocked_stdin_stream");
		expect(requestMethods).toContain(sdk.methods.agent.session.setMode);

		// Test the custom writable stream behavior
		const customWritable = ndJsonStreamArgs[0] as WritableStream;
		expect(customWritable).toBeInstanceOf(WritableStream);

		// Write to it
		const writer = customWritable.getWriter();
		await writer.write(new Uint8Array([1, 2, 3]));
		expect(writerWritten).toBe(true);

		await writer.close();
		expect(writerClosed).toBe(true);
	});
});
