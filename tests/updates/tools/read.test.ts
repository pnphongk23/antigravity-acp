import { describe, expect, test } from "bun:test";
import type { StepRow } from "../../../src/types";
import { readUpdate } from "../../../src/updates/tools/read";

describe("updates/tools/read.ts", () => {
	describe("readUpdate()", () => {
		test("list_dir uses native protobuf decoder", () => {
			const step = {
				stepType: 9,
				stepPayload: {
					toolRun: { call: { rawInputJson: "{}" } },
					listDirectory: {
						dirUri: "file:///a/b",
						entries: [
							{ name: "src", isDirectory: 1 },
							{ name: "file.txt", isDirectory: 0 },
						],
					},
				},
			} as unknown as StepRow;

			const update: any = readUpdate(step, "/a");
			expect(update.title).toBe("Read b");
			expect(update.content).toEqual([
				{
					type: "content",
					content: { type: "text", text: "```\nsrc/\nfile.txt\n```" },
				},
			]);
			expect(update.locations).toEqual([{ path: "/a/b" }]);
		});

		test("list_dir fallbacks to raw input if protobuf missing", () => {
			const step = {
				stepType: 9,
				stepPayload: {
					toolRun: {
						call: {
							namePrimary: "list_dir",
							rawInputJson: JSON.stringify({ DirectoryPath: "/a/b" }),
						},
					},
				},
			} as StepRow;

			const update: any = readUpdate(step, "/a");
			expect(update.title).toBe("Read b");
			expect(update.content).toBeUndefined();
		});

		test("view_file uses native protobuf decoder with range", () => {
			const step = {
				stepType: 8,
				stepPayload: {
					toolRun: { call: { rawInputJson: "{}" } },
					viewFile: {
						fileUri: "file:///a/b.txt",
						startLine: 5,
						endLine: 10,
						content: "lines 5 to 10",
					},
				},
			} as unknown as StepRow;

			const update: any = readUpdate(step, "/a");
			expect(update.title).toBe("Read b.txt:5-10");
			expect(update.content).toEqual([
				{
					type: "content",
					content: { type: "text", text: "```\nlines 5 to 10\n```" },
				},
			]);
			expect(update.locations).toEqual([{ path: "/a/b.txt", line: 5 }]);
		});

		test("view_file prefers raw input absolute path", () => {
			const step = {
				stepType: 8,
				stepPayload: {
					toolRun: {
						call: {
							rawInputJson: JSON.stringify({ AbsolutePath: "/a/c.txt" }),
						},
					},
					viewFile: {
						fileUri: "file:///a/b.txt",
					},
				},
			} as unknown as StepRow;

			const update: any = readUpdate(step, "/a");
			expect(update.title).toBe("Read c.txt");
			expect(update.locations).toEqual([{ path: "/a/c.txt", line: 1 }]);
		});

		test("step 132 view_file without protobuf content reads from disk", () => {
			const path = "/tmp/agy-acp-read-test.txt";
			Bun.write(
				path,
				["line1", "line2", "line3", "line4", "line5"].join("\n"),
			);

			const step = {
				idx: 3,
				stepType: 132,
				status: 3,
				stepPayload: {
					toolRun: {
						call: {
							namePrimary: "view_file",
							rawInputJson: JSON.stringify({
								AbsolutePath: path,
								StartLine: 2,
								EndLine: 4,
								toolSummary: "Check slice",
							}),
						},
					},
				},
				permission: {
					kind: "read_file",
					value: path,
					decision: 1,
				},
			} as unknown as StepRow;

			const update: any = readUpdate(step);
			expect(update.title).toBe("Check slice");
			expect(update.content[0].content.text).toContain("line2");
			expect(update.content[0].content.text).toContain("line4");
			expect(update.content.some((c: any) =>
				c.content?.text?.includes("Permission requested"),
			)).toBe(false);
		});
	});
});
