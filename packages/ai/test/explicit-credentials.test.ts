import { describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { envApiKeyAuth } from "../src/auth/helpers.ts";
import { resolveProviderAuth } from "../src/auth/resolve.ts";
import type { AuthContext, Credential, ProviderAuth } from "../src/auth/types.ts";
import { createModels } from "../src/models.ts";
import { amazonBedrockProvider } from "../src/providers/amazon-bedrock.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import { cloudflareAIGatewayAuth, cloudflareWorkersAIAuth } from "../src/providers/cloudflare-auth.ts";
import { googleVertexProvider } from "../src/providers/google-vertex.ts";
import { EXPLICIT_CREDENTIAL_ENV, getProviderEnvValue } from "../src/utils/provider-env.ts";

function explicitContext(): AuthContext {
	return {
		credentialMode: "explicit",
		env: vi.fn(async () => "ambient-identity"),
		fileExists: vi.fn(async () => true),
	};
}

async function resolve(auth: ProviderAuth, credential?: Credential, ctx = explicitContext()) {
	const store = new InMemoryCredentialStore();
	if (credential) await store.modify("test", async () => credential);
	const result = await resolveProviderAuth({ id: "test", auth }, store, ctx);
	expect(ctx.env).not.toHaveBeenCalled();
	return result;
}

const standard = { apiKey: envApiKeyAuth("test key", ["TEST_KEY"]) };

describe("explicit credential identity isolation", () => {
	it("does not borrow ambient keys for missing, empty or unresolved bound credentials", async () => {
		for (const credential of [undefined, { type: "api_key" as const }, { type: "api_key" as const, key: "" }]) {
			expect(await resolve(standard, credential)).toBeUndefined();
		}
	});

	it("uses stored keys and resolved env references without ambient context", async () => {
		expect(await resolve(standard, { type: "api_key", key: "slot-key" })).toMatchObject({
			auth: { apiKey: "slot-key" },
			env: { [EXPLICIT_CREDENTIAL_ENV]: "1" },
		});
		expect(await resolve(standard, { type: "api_key", env: { TEST_KEY: "referenced-key" } })).toMatchObject({
			auth: { apiKey: "referenced-key" },
		});
	});

	it("keeps default ambient semantics unchanged", async () => {
		const ctx = explicitContext();
		delete ctx.credentialMode;
		expect(
			await resolveProviderAuth({ id: "test", auth: standard }, new InMemoryCredentialStore(), ctx),
		).toMatchObject({ auth: { apiKey: "ambient-identity" } });
		expect(ctx.env).toHaveBeenCalledWith("TEST_KEY");
	});

	it("keeps request override scoping and allows an explicitly resolved env reference", async () => {
		const ctx = explicitContext();
		const store = new InMemoryCredentialStore();
		expect(
			await resolveProviderAuth({ id: "test", auth: standard }, store, ctx, { env: { TEST_KEY: "override-key" } }),
		).toMatchObject({ auth: { apiKey: "override-key" } });
		expect(await resolveProviderAuth({ id: "test", auth: standard }, store, ctx, { apiKey: "" })).toBeUndefined();
		expect(ctx.env).not.toHaveBeenCalled();
	});

	it("requires complete Cloudflare account/gateway config and preserves header ownership", async () => {
		const workers = { apiKey: cloudflareWorkersAIAuth() };
		const gateway = { apiKey: cloudflareAIGatewayAuth() };
		expect(await resolve(workers, { type: "api_key", key: "slot-key" })).toBeUndefined();
		expect(
			await resolve(gateway, { type: "api_key", key: "slot-key", env: { CLOUDFLARE_ACCOUNT_ID: "account" } }),
		).toBeUndefined();
		expect(
			await resolve(workers, {
				type: "api_key",
				env: { CLOUDFLARE_API_KEY: "ref-key", CLOUDFLARE_ACCOUNT_ID: "account" },
			}),
		).toMatchObject({ auth: { apiKey: "ref-key" }, env: { CLOUDFLARE_ACCOUNT_ID: "account" } });
		expect(
			await resolve(gateway, {
				type: "api_key",
				key: "slot-key",
				env: { CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_GATEWAY_ID: "gateway" },
			}),
		).toMatchObject({
			auth: { headers: { "cf-aig-authorization": "Bearer slot-key", Authorization: null, "x-api-key": null } },
		});
	});

	it("never borrows an Anthropic ambient bearer or federation identity", async () => {
		const auth = anthropicProvider().auth;
		expect(await resolve(auth, { type: "api_key" })).toBeUndefined();
		expect(await resolve(auth, { type: "api_key", key: "slot-key" })).toMatchObject({ auth: { apiKey: "slot-key" } });
		expect(await resolve(auth, { type: "api_key", env: { ANTHROPIC_AUTH_TOKEN: "explicit-token" } })).toMatchObject({
			auth: { headers: { Authorization: "Bearer explicit-token" } },
		});
	});

	it("rejects ambient AWS chains/profiles but accepts explicit bearer and static access keys", async () => {
		const auth = amazonBedrockProvider().auth;
		await expect(resolve(auth, { type: "api_key", env: { AWS_PROFILE: "named" } })).rejects.toThrow(
			"API key auth failed",
		);
		await expect(resolve(auth, { type: "api_key" })).rejects.toThrow("API key auth failed");
		expect(await resolve(auth, { type: "api_key", key: "slot-token" })).toMatchObject({
			auth: { apiKey: "slot-token" },
		});
		expect(await resolve(auth, { type: "api_key", env: { AWS_BEARER_TOKEN_BEDROCK: "ref-token" } })).toMatchObject({
			auth: { apiKey: "ref-token" },
		});
		expect(
			await resolve(auth, {
				type: "api_key",
				env: { AWS_ACCESS_KEY_ID: "slot-id", AWS_SECRET_ACCESS_KEY: "slot-secret" },
			}),
		).toMatchObject({ auth: {}, env: { AWS_ACCESS_KEY_ID: "slot-id", AWS_SECRET_ACCESS_KEY: "slot-secret" } });
	});

	it("requires explicit Vertex file/project/location and never checks default ADC", async () => {
		const auth = googleVertexProvider().auth;
		const ctx = explicitContext();
		await expect(
			resolve(
				auth,
				{ type: "api_key", env: { GOOGLE_CLOUD_PROJECT: "project", GOOGLE_CLOUD_LOCATION: "location" } },
				ctx,
			),
		).rejects.toThrow("API key auth failed");
		expect(ctx.fileExists).not.toHaveBeenCalled();
		expect(
			await resolve(
				auth,
				{
					type: "api_key",
					env: {
						GOOGLE_APPLICATION_CREDENTIALS: "/explicit/account.json",
						GOOGLE_CLOUD_PROJECT: "project",
						GOOGLE_CLOUD_LOCATION: "location",
					},
				},
				ctx,
			),
		).toMatchObject({
			auth: {},
			env: {
				GOOGLE_APPLICATION_CREDENTIALS: "/explicit/account.json",
				GOOGLE_CLOUD_PROJECT: "project",
				GOOGLE_CLOUD_LOCATION: "location",
			},
		});
		expect(ctx.fileExists).toHaveBeenCalledWith("/explicit/account.json");
	});

	it("keeps OAuth bound to its credential without ambient key fallback", async () => {
		const toAuth = vi.fn(async () => ({ apiKey: "oauth-slot-token" }));
		const oauth = { name: "test", login: vi.fn(), refresh: vi.fn(), toAuth };
		expect(
			await resolve(
				{ ...standard, oauth },
				{ type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 3600000 },
			),
		).toMatchObject({ auth: { apiKey: "oauth-slot-token" }, env: { [EXPLICIT_CREDENTIAL_ENV]: "1" } });
		expect(
			await resolve(standard, {
				type: "oauth",
				access: "access",
				refresh: "refresh",
				expires: Date.now() + 3600000,
			}),
		).toBeUndefined();
	});

	it("failed OAuth refresh never falls back to an ambient key", async () => {
		const ctx = explicitContext();
		const store = new InMemoryCredentialStore();
		await store.modify("test", async () => ({ type: "oauth", access: "expired", refresh: "rotation", expires: 0 }));
		const oauth = {
			name: "test",
			login: vi.fn(),
			refresh: vi.fn(async () => {
				throw new Error("mock refresh failure");
			}),
			toAuth: vi.fn(),
		};
		await expect(resolveProviderAuth({ id: "test", auth: { ...standard, oauth } }, store, ctx)).rejects.toThrow(
			"OAuth refresh failed",
		);
		expect(ctx.env).not.toHaveBeenCalled();
		expect(await store.read("test")).toMatchObject({ refresh: "rotation" });
	});

	it("availability checks and model refresh do not consult ambient identity", async () => {
		const ctx = explicitContext();
		const store = new InMemoryCredentialStore();
		await store.modify("anthropic", async () => ({ type: "api_key" }));
		const models = createModels({ credentials: store, authContext: ctx });
		models.setProvider(anthropicProvider());
		expect(await models.checkAuth("anthropic")).toBeUndefined();
		await models.refresh({ allowNetwork: false });
		expect(ctx.env).not.toHaveBeenCalled();
	});

	it("request-scoped env markers suppress process fallback without mutating it", () => {
		const before = { ...process.env };
		expect(getProviderEnvValue("PATH", { [EXPLICIT_CREDENTIAL_ENV]: "1" })).toBeUndefined();
		expect(getProviderEnvValue("PATH", { [EXPLICIT_CREDENTIAL_ENV]: "1", PATH: "scoped" })).toBe("scoped");
		expect(process.env).toEqual(before);
	});
});
