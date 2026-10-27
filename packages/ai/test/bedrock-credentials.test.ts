import { afterEach, describe, expect, it, vi } from "vitest";

const bedrockMock = vi.hoisted(() => ({
	constructorCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		constructor(config: Record<string, unknown>) {
			bedrockMock.constructorCalls.push(config);
		}

		send(): Promise<never> {
			return Promise.reject(new Error("mock send"));
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;

		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import type { BedrockOptions } from "../src/api/bedrock-converse-stream.ts";
import { stream as streamBedrock } from "../src/compat.ts";
import { getBuiltinModel } from "../src/providers/all.ts";
import type { Context, Model, ProviderEnv } from "../src/types.ts";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
};

async function captureClientConfig(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions = {},
): Promise<Record<string, unknown>> {
	bedrockMock.constructorCalls.length = 0;
	await streamBedrock(model, context, { cacheRetention: "none", ...options }).result();
	expect(bedrockMock.constructorCalls).toHaveLength(1);
	return bedrockMock.constructorCalls[0];
}

describe("bedrock credential priority", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("prefers explicit and scoped profiles over ambient AWS access keys", async () => {
		vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAEXAMPLE");
		vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secretexample");
		const model = getBuiltinModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");

		let config = await captureClientConfig(model, { profile: "explicit-profile" });

		expect(config.profile).toBe("explicit-profile");
		expect(config.credentials).toBeUndefined();

		config = await captureClientConfig(model, { env: { AWS_PROFILE: "scoped-profile" } });

		expect(config.profile).toBe("scoped-profile");
		expect(config.credentials).toBeUndefined();
	});

	it("uses ambient AWS access keys when no profile is configured", async () => {
		vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAEXAMPLE");
		vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secretexample");
		const model = getBuiltinModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");

		const config = await captureClientConfig(model);

		expect(config.profile).toBeUndefined();
		expect(config.credentials).toEqual({
			accessKeyId: "AKIAEXAMPLE",
			secretAccessKey: "secretexample",
		});
	});

	it("uses ambient AWS access keys when only an ambient profile is set", async () => {
		vi.stubEnv("AWS_ACCESS_KEY_ID", "AKIAEXAMPLE");
		vi.stubEnv("AWS_SECRET_ACCESS_KEY", "secretexample");
		vi.stubEnv("AWS_PROFILE", "ambient-profile");
		const model = getBuiltinModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");

		const config = await captureClientConfig(model);

		expect(config.profile).toBe("ambient-profile");
		expect(config.credentials).toEqual({
			accessKeyId: "AKIAEXAMPLE",
			secretAccessKey: "secretexample",
		});
	});
});

// Strict named bindings must not leak back to the SDK's environment providers.
describe("explicit Bedrock credential isolation", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("ignores ambient bearer/profile/access keys for scoped static credentials", async () => {
		vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "ambient-bearer");
		vi.stubEnv("AWS_PROFILE", "ambient-profile");
		vi.stubEnv("AWS_ACCESS_KEY_ID", "ambient-id");
		vi.stubEnv("AWS_SECRET_ACCESS_KEY", "ambient-secret");
		const model = getBuiltinModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");
		const config = await captureClientConfig(model, {
			env: {
				PI_AUTH_EXPLICIT_CREDENTIALS: "1",
				AWS_ACCESS_KEY_ID: "slot-id",
				AWS_SECRET_ACCESS_KEY: "slot-secret",
			},
		});
		expect(config.profile).toBeUndefined();
		expect(config.credentials).toEqual({ accessKeyId: "slot-id", secretAccessKey: "slot-secret" });
		expect(config.authSchemePreference).toEqual(["sigv4"]);
		expect(typeof config.token).toBe("function");
	});

	it("uses only the explicit bearer token", async () => {
		vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "ambient-bearer");
		const model = getBuiltinModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");
		const config = await captureClientConfig(model, {
			apiKey: "slot-token",
			env: { PI_AUTH_EXPLICIT_CREDENTIALS: "1" },
		});
		expect(config.token).toEqual({ token: "slot-token" });
		expect(config.authSchemePreference).toEqual(["httpBearerAuth"]);
		expect(config.credentials).toEqual({ accessKeyId: "unused", secretAccessKey: "unused" });
	});

	it("rejects missing credentials, profiles and skip-auth before constructing an SDK client", async () => {
		vi.stubEnv("AWS_BEARER_TOKEN_BEDROCK", "ambient-bearer");
		vi.stubEnv("AWS_ACCESS_KEY_ID", "ambient-id");
		vi.stubEnv("AWS_SECRET_ACCESS_KEY", "ambient-secret");
		const model = getBuiltinModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");
		const environments: ProviderEnv[] = [{}, { AWS_PROFILE: "slot-profile" }, { AWS_BEDROCK_SKIP_AUTH: "1" }];
		for (const env of environments) {
			bedrockMock.constructorCalls.length = 0;
			const result = await streamBedrock(model, context, {
				env: { PI_AUTH_EXPLICIT_CREDENTIALS: "1", ...env },
			}).result();
			expect(result.stopReason).toBe("error");
			expect(result.errorMessage).toContain("Explicit Bedrock credentials require");
			expect(bedrockMock.constructorCalls).toHaveLength(0);
		}
	});
});
