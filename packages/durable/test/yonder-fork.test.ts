import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
	createRegistry,
	defineExtension,
	GenerationTask,
	Harness,
	hook,
	LiveDoc,
	MemoryStorage,
	RunReceiptDoc,
} from "@earendil-works/pi-durable";
import { expect, it } from "vitest";

// Real authenticated loopback HTTP failures, no synthetic model streams or answers.
async function openFailureEndpoint(decision: boolean, delay = 20) {
	const key = randomUUID();
	const calls: number[] = [];
	const server = createServer((req, res) => {
		expect(req.headers.authorization).toBe(`Bearer ${key}`);
		calls.push(Date.now());
		res.writeHead(503, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: "Service unavailable" } }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing HTTP port");
	const models = createModels();
	models.setProvider(
		createProvider({
			id: "loopback",
			baseUrl: `http://127.0.0.1:${address.port}/v1`,
			auth: { apiKey: { name: "Ephemeral loopback credential", resolve: async () => ({ auth: { apiKey: key } }) } },
			models: [
				{
					id: "gpt-6-luna",
					name: "gpt-6-luna",
					api: "openai-completions",
					provider: "loopback",
					baseUrl: `http://127.0.0.1:${address.port}/v1`,
					reasoning: false,
					input: ["text"],
					contextWindow: 32768,
					maxTokens: 1024,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			],
			api: openAICompletionsApi(),
		}),
	);
	let retryEnabled = decision;
	const registry = createRegistry();
	registry.install(
		defineExtension({ name: "retry-policy", hooks: [hook(GenerationTask, { shouldRetry: () => retryEnabled })] }),
	);
	let boundaries = 0;
	const harness = await Harness.open(
		new MemoryStorage(),
		{
			models,
			registry,
			settings: {
				retry: { maxRetries: 2, baseDelayMs: delay > 100 ? delay : 100, maxAgentDelayMs: delay },
				stream: { maxRetries: 0 },
			},
			beforeAgent: async ({ conversationId }, ctx) => {
				boundaries++;
				// The host can commit configuration before the task resolves its agent.
				const conversation = await harness.conversation(conversationId, ctx);
				await conversation!.configure({ model: { provider: "loopback", modelId: "gpt-6-luna" } }, ctx);
			},
		},
		context,
	);
	const conversation = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
	return {
		harness,
		conversation,
		calls,
		boundaries: () => boundaries,
		stopRetry: () => {
			retryEnabled = false;
		},
		close: async () => {
			await harness.close(context);
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}

it.each([false, true])(
	"host retry classification %s retains native budget/cap and atomic error receipt",
	async (decision) => {
		const opened = await openFailureEndpoint(decision);
		try {
			const input = await opened.conversation.submit(
				{ type: "input", content: "Check provider availability." },
				context,
			);
			const result = await input.wait(context);
			expect(result).toMatchObject({ status: "unanswered", reason: "model_error" });
			expect(opened.calls).toHaveLength(decision ? 3 : 1);
			if (decision) {
				for (let i = 1; i < opened.calls.length; i++)
					expect(opened.calls[i]! - opened.calls[i - 1]!).toBeGreaterThanOrEqual(15);
				// The uncapped first backoff alone is 100ms; the two capped sleeps total 40ms.
				expect(opened.calls[2]! - opened.calls[0]!).toBeLessThan(250);
				expect(result).toMatchObject({ detail: expect.stringContaining("retries exhausted (2 retries)") });
			}
			expect(opened.boundaries()).toBeGreaterThan(0);
			expect(
				await opened.harness.snapshot(RunReceiptDoc, opened.conversation.id, String(input.id), context),
			).toMatchObject({
				inputs: [input.id],
				settlement: {
					status: result.status,
					reason: "model_error",
					detail: "detail" in result ? result.detail : undefined,
				},
				usage: { models: {}, tools: {} },
			});
			expect((await opened.harness.snapshot(LiveDoc, opened.conversation.id, context))?.run).toBeUndefined();
		} finally {
			await opened.close();
		}
	},
);

it("abort interrupts a long backoff, settles a receipt and continues queued inputs", async () => {
	const opened = await openFailureEndpoint(true, 300000);
	try {
		const first = await opened.conversation.submit(
			{ type: "input", content: "Check provider availability." },
			context,
		);
		const pending = first.wait(context);
		await expect
			.poll(async () => (await opened.harness.snapshot(LiveDoc, opened.conversation.id, context))?.generation?.retry)
			.toBeDefined();
		const second = await opened.conversation.submit(
			{ type: "input", content: "Check provider availability again.", whenBusy: "followUp" },
			context,
		);
		const start = Date.now();
		opened.stopRetry();
		const live = await opened.harness.snapshot(LiveDoc, opened.conversation.id, context);
		await opened.harness.abortTask(live!.run!.taskId, context);
		expect(await pending).toMatchObject({ status: "unanswered", reason: "aborted" });
		expect(Date.now() - start).toBeLessThan(1000);
		expect(await second.wait(context)).toMatchObject({ status: "unanswered", reason: "model_error" });
		for (const [input, reason] of [
			[first, "aborted"],
			[second, "model_error"],
		] as const) {
			expect(
				await opened.harness.snapshot(RunReceiptDoc, opened.conversation.id, String(input.id), context),
			).toMatchObject({ inputs: [input.id], settlement: { reason } });
		}
	} finally {
		await opened.close();
	}
});
