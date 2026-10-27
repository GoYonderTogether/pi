import { createModels, fauxAssistantMessage, fauxToolCall, type Models, Type } from "@earendil-works/pi-ai";
import {
	AgentDoc,
	CompactionTask,
	createRegistry,
	defineTask,
	defineTool,
	GenerationTask,
	Harness,
	type HarnessOptions,
	LiveDoc,
	MemoryStorage,
} from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { chatSetup, waitFor } from "./chat-support.ts";
import { addHooks, addSection, addTask, addTool } from "./harness-support.ts";
import { ControlledStorage, context } from "./session-support.ts";
import { abortedWith, completed, deferred } from "./task-support.ts";

const model = { provider: "faux", modelId: "faux-1" };

describe("invocation-bound Models", () => {
	it("keeps the default Models and lazy agent behavior without a resolver", async () => {
		const models = createModels();
		const beforeAgent = vi.fn();
		const task = defineTask({
			name: "default-models",
			version: 1,
			initial: () => ({ phase: "run" as const }),
			phases: {
				run: async (_task, runtime, ctx) => {
					expect(runtime.models.getProviders()).toEqual(models.getProviders());
					await runtime.commit(() => completed(null), ctx);
				},
			},
			abort: async (_task, runtime, ctx) => runtime.commit(() => abortedWith("cancelled"), ctx),
		});
		const registry = createRegistry();
		addTask(registry, task);
		const harness = await Harness.open(new MemoryStorage(), { models, registry, beforeAgent }, context);
		try {
			const root = await harness.root(context);
			const id = await root.commit(
				(tx) => tx.createTask(task, {}, { ownership: { kind: "conversation" } }),
				context,
			);
			expect((await harness.waitForTask(id, context)).state.outcome.status).toBe("completed");
			expect(beforeAgent).not.toHaveBeenCalled();
		} finally {
			await harness.close(context);
		}
	});

	it("prepares before resolving and pins Models across phases even when later agent preparation changes", async () => {
		const first = createModels();
		const later = createModels();
		let selected = first;
		const order: string[] = [];
		const registry = createRegistry();
		const task = defineTask<Record<string, never>, { phase: "first" | "second" }, null>({
			name: "pinned-models",
			version: 1,
			initial: () => ({ phase: "first" }),
			phases: {
				first: async (_task, runtime, ctx) => {
					order.push("first");
					expect(runtime.models).toBe(first);
					await runtime.agent(ctx);
					selected = later;
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "second" } }), ctx);
				},
				second: async (_task, runtime, ctx) => {
					await runtime.agent(ctx);
					order.push("second");
					expect(runtime.models).toBe(first);
					await runtime.commit(() => completed(null), ctx);
				},
			},
			abort: async (_task, runtime, ctx) => runtime.commit(() => abortedWith("cancelled"), ctx),
		});
		addTask(registry, task);
		const resolveModels = vi.fn<NonNullable<HarnessOptions["resolveModels"]>>(
			async ({ conversationId, read }, ctx) => {
				order.push("resolve");
				expect((await read.snapshot(AgentDoc, conversationId, ctx))?.instructions).toBe("prepared");
				return selected;
			},
		);
		let harness!: Harness;
		harness = await Harness.open(
			new MemoryStorage(),
			{
				models: createModels(),
				registry,
				resolveModels,
				beforeAgent: async ({ conversationId }, ctx) => {
					order.push("beforeAgent");
					await harness.commit(async (tx) => {
						(await tx.doc(AgentDoc, conversationId)).instructions = "prepared";
					}, ctx);
				},
			},
			context,
		);
		try {
			const root = await harness.root(context);
			const id = await root.commit(
				(tx) => tx.createTask(task, {}, { ownership: { kind: "conversation" } }),
				context,
			);
			expect((await harness.waitForTask(id, context)).state.outcome.status).toBe("completed");
			expect(resolveModels).toHaveBeenCalledTimes(1);
			expect(order).toEqual(["beforeAgent", "resolve", "first", "beforeAgent", "second"]);
		} finally {
			await harness.close(context);
		}
	});

	it("isolates concurrent conversations through generation, hooks, tools, and the post-tool request", async () => {
		const a = chatSetup();
		const b = chatSetup();
		const selected = new Map<number, Models>();
		const both = deferred();
		let reached = 0;
		const toolModels: Models[] = [];
		addTool(
			a.registry,
			defineTool({
				name: "bound-tool",
				description: "Check model access",
				parameters: Type.Object({}),
				execute: async (_args, api, ctx) => {
					toolModels.push(api.models);
					expect(api.models).toBe(selected.get(api.conversationId));
					const resolved = api.models.getModel("faux", "faux-1")!;
					await api.models.completeSimple(resolved, { messages: [] }, { signal: ctx.abortSignal });
					return { output: [] };
				},
			}),
		);
		addHooks(a.registry, GenerationTask, {
			beforeRequest: (_request, api) => {
				expect(api.models).toBe(selected.get(api.conversationId));
			},
		});
		for (const setup of [a, b])
			setup.faux.setResponses([
				async () => {
					if (++reached === 2) both.resolve();
					await both.promise;
					return fauxAssistantMessage([fauxToolCall("bound-tool", {})], { stopReason: "toolUse" });
				},
				fauxAssistantMessage("tool model call"),
				fauxAssistantMessage("answer"),
			]);
		const harness = await Harness.open(
			new MemoryStorage(),
			{
				models: createModels(),
				registry: a.registry,
				resolveModels: async ({ conversationId }) => selected.get(conversationId)!,
			},
			context,
		);
		try {
			const first = await harness.root(context, { agent: { model } });
			const second = await harness.createConversation(
				{ ownership: { kind: "ownerless" }, agent: { model } },
				context,
			);
			selected.set(first.id, a.models);
			selected.set(second.id, b.models);
			const submissions = await Promise.all(
				[first, second].map((conversation) => conversation.submit({ type: "input", content: "hi" }, context)),
			);
			expect(
				(await Promise.all(submissions.map((submission) => submission.wait(context)))).map(
					(record) => record.status,
				),
			).toEqual(["done", "done"]);
			expect(toolModels).toHaveLength(2);
			expect(a.faux.state.callCount).toBe(3);
			expect(b.faux.state.callCount).toBe(3);
		} finally {
			await harness.close(context);
		}
	});

	it("restores the frozen run binding for deferred poll after the host default changes", async () => {
		const setup = chatSetup({ deferred: { pollAfterMs: 10 } });
		const other = createModels();
		let selected = setup.models;
		const fetch = vi.spyOn(setup.models, "fetchDeferred");
		// A resumed invocation resolves the host's frozen run binding, not its mutable default.
		const resolveModels = vi.fn(async () => setup.models);
		addSection(setup.registry, "change-host-default", () => {
			selected = other;
			return "prepared";
		});
		setup.faux.setResponses([fauxAssistantMessage("deferred answer")]);
		const harness = await Harness.open(
			new MemoryStorage(),
			{
				models: other,
				registry: setup.registry,
				resolveModels,
				settings: { stream: { deferred: true } },
			},
			context,
		);
		try {
			const root = await harness.root(context, { agent: { model } });
			const submission = await root.submit({ type: "input", content: "hi" }, context);
			expect((await submission.wait(context)).status).toBe("done");
			expect(selected).toBe(other);
			expect(resolveModels).toHaveBeenCalledTimes(2);
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(setup.faux.state.deferredFetchCount).toBe(1);
		} finally {
			await harness.close(context);
		}
	});

	it("resolves the frozen run binding again for deferred cancellation's fresh abort invocation", async () => {
		const setup = chatSetup({ deferred: { pollAfterMs: 60_000 } });
		setup.faux.setResponses([fauxAssistantMessage("later")]);
		const cancel = vi.spyOn(setup.models, "cancelDeferred");
		const resolveModels = vi.fn(async () => setup.models);
		const harness = await Harness.open(
			new MemoryStorage(),
			{
				models: createModels(),
				registry: setup.registry,
				resolveModels,
				settings: { stream: { deferred: true } },
			},
			context,
		);
		try {
			const root = await harness.root(context, { agent: { model } });
			const submission = await root.submit({ type: "input", content: "hi" }, context);
			await waitFor(
				async () => (await harness.snapshot(LiveDoc, root.id, context))?.generation?.deferred !== undefined,
			);
			await root.abort(context);
			expect((await submission.wait(context)).status).toBe("unanswered");
			expect(resolveModels).toHaveBeenCalledTimes(2);
			expect(cancel).toHaveBeenCalledTimes(1);
			expect(setup.faux.state.cancelledDeferred).toHaveLength(1);
		} finally {
			await harness.close(context);
		}
	});

	it("uses the binding in compaction selection, summary, and hooks", async () => {
		const setup = chatSetup();
		let selected = setup.models;
		const summarize = vi.spyOn(setup.models, "completeSimple");
		const resolveModels = vi.fn(async () => selected);
		const harness = await Harness.open(
			new MemoryStorage(),
			{
				models: createModels(),
				registry: setup.registry,
				resolveModels,
				settings: { compaction: { enabled: false, keepRecentTokens: 10, reserveTokens: 1000 } },
			},
			context,
		);
		try {
			const root = await harness.root(context, { agent: { model } });
			setup.faux.setResponses([
				fauxAssistantMessage("a".repeat(400)),
				fauxAssistantMessage("b".repeat(400)),
				fauxAssistantMessage("summary"),
			]);
			for (const content of ["one".repeat(100), "two".repeat(100)]) {
				const submission = await root.submit({ type: "input", content }, context);
				expect((await submission.wait(context)).status).toBe("done");
			}
			// A host reload during selection cannot change the summarization phase's Models.
			addHooks(setup.registry, CompactionTask, {
				beforeCompact: (_request, api) => {
					expect(api.models).toBe(setup.models);
					selected = createModels();
				},
			});
			const compaction = await root.compact(undefined, context);
			expect((await harness.waitForTask(compaction, context)).state.outcome.status).toBe("completed");
			expect(summarize).toHaveBeenCalledTimes(1);
			expect(setup.faux.state.callCount).toBe(3);
		} finally {
			await harness.close(context);
		}
	});

	it("restores the application run binding when reopening a deferred poll", async () => {
		const setup = chatSetup({ deferred: { pollAfterMs: 60_000 } });
		const storage = new ControlledStorage();
		let now = 1_000;
		const resolveModels = vi.fn(async () => setup.models);
		const options: HarnessOptions = {
			models: createModels(),
			registry: setup.registry,
			resolveModels,
			settings: { stream: { deferred: true } },
			now: () => now,
		};
		setup.faux.setResponses([fauxAssistantMessage("restored answer")]);
		let harness = await Harness.open(storage, options, context);
		try {
			const root = await harness.root(context, { agent: { model } });
			const submission = await root.submit({ type: "input", content: "hi" }, context);
			await waitFor(
				async () => (await harness.snapshot(LiveDoc, root.id, context))?.generation?.deferred !== undefined,
			);
			await harness.close(context);
			now = 61_000;
			harness = await Harness.open(storage.reopen(), options, context);
			const restored = (await harness.submission(submission.id, context))!;
			expect((await restored.wait(context)).status).toBe("done");
			expect(resolveModels).toHaveBeenCalledTimes(2);
			expect(setup.faux.state.callCount).toBe(1);
			expect(setup.faux.state.deferredFetchCount).toBe(1);
		} finally {
			await harness.close(context);
		}
	});

	it("faults a task when its async resolver fails instead of falling back to default Models", async () => {
		const setup = chatSetup();
		const harness = await Harness.open(
			new MemoryStorage(),
			{
				models: setup.models,
				registry: setup.registry,
				resolveModels: async () => {
					throw new Error("unknown slot");
				},
			},
			context,
		);
		try {
			const root = await harness.root(context, { agent: { model } });
			const submission = await root.submit({ type: "input", content: "hi" }, context);
			expect(await submission.wait(context)).toMatchObject({ status: "unanswered", reason: "faulted" });
			expect(setup.faux.state.callCount).toBe(0);
		} finally {
			await harness.close(context);
		}
	});
});
