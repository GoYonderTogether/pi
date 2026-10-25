import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getOrThrow } from "../src/env/index.ts";
import { type LocalProcessSpawn, NodeExecutionEnv } from "../src/env/node.ts";

const roots: string[] = [];
const processes: ReturnType<LocalProcessSpawn>[] = [];

function tempDir(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-local-spawn-"));
	roots.push(root);
	return root;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// Deliberately not detached: Pi must call cancel, never signal this child's assumed process group.
const localSpawn: LocalProcessSpawn = (request) => {
	const child = spawn(request.program, request.args, {
		cwd: request.cwd,
		env: request.env,
		stdio: [request.stdin, "pipe", "pipe"],
		windowsHide: true,
	});
	const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
	const process = {
		child,
		cancel: vi.fn(() => {
			child.kill("SIGKILL");
		}),
		result,
	};
	processes.push(process);
	return process;
};

afterEach(async () => {
	for (const process of processes.splice(0)) {
		if (process.child.exitCode === null && process.child.signalCode === null) process.cancel();
		await process.result.catch(() => undefined);
	}
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("NodeExecutionEnv local spawn adapter", () => {
	it("forwards exact argv, resolved cwd and a replacement environment without shell parsing", async () => {
		const root = tempDir();
		const adapter = vi.fn(localSpawn);
		const env = new NodeExecutionEnv({ cwd: root, shellEnv: { CONFIGURED: "not inherited" }, localSpawn: adapter });
		const args = ["two words", "$(touch unexpected)", "quote'\"", "", "a\nb"];
		const script = "process.stdout.write(JSON.stringify(process.argv.slice(1)));process.stderr.write('stderr')";
		let stdout = "";
		let stderr = "";
		const result = await env.exec(
			[process.execPath, "-e", script, ...args],
			{
				cwd: ".",
				inheritEnv: false,
				env: { EXPLICIT: "only" },
				onOutput: (text, context, info) => {
					expect(context).toBe(BACKGROUND_CONTEXT);
					if (info.stream === "stdout") stdout += text;
					else stderr += text;
				},
			},
			BACKGROUND_CONTEXT,
		);
		expect(getOrThrow(result)).toEqual({ exitCode: 0 });
		expect(JSON.parse(stdout)).toEqual(args);
		expect(stderr).toBe("stderr");
		expect(adapter).toHaveBeenCalledExactlyOnceWith({
			program: process.execPath,
			args: ["-e", script, ...args],
			cwd: root,
			env: { EXPLICIT: "only" },
			stdin: "ignore",
		});
		await env.cleanup(BACKGROUND_CONTEXT);
		expect(processes[0]!.cancel).not.toHaveBeenCalled();
	});

	it("merges inherited, configured and per-call environments before invoking the adapter", async () => {
		const adapter = vi.fn(localSpawn);
		const env = new NodeExecutionEnv({ cwd: tempDir(), shellEnv: { CONFIGURED: "base" }, localSpawn: adapter });
		getOrThrow(
			await env.exec(
				[process.execPath, "-e", ""],
				{ env: { CONFIGURED: "override", EXTRA: "extra" } },
				BACKGROUND_CONTEXT,
			),
		);
		expect(adapter.mock.calls[0]![0].env).toEqual({ ...process.env, CONFIGURED: "override", EXTRA: "extra" });
	});

	it.skipIf(process.platform === "win32")("passes shell strings through the configured shell unchanged", async () => {
		const adapter = vi.fn(localSpawn);
		const env = new NodeExecutionEnv({ cwd: tempDir(), shellPath: "/bin/bash", localSpawn: adapter });
		const command = "printf '%s' 'a b;$(not-expanded)'; exit 7";
		let output = "";
		expect(
			getOrThrow(
				await env.exec(
					command,
					{
						onOutput: (text) => {
							output += text;
						},
					},
					BACKGROUND_CONTEXT,
				),
			),
		).toEqual({ exitCode: 7 });
		expect(output).toBe("a b;$(not-expanded)");
		expect(adapter.mock.calls[0]![0]).toMatchObject({ program: "/bin/bash", args: ["-c", command], stdin: "ignore" });
	});

	it.skipIf(process.platform === "win32")("keeps legacy shell command transport on piped stdin", async () => {
		const root = tempDir();
		const shellPath = "C:\\Windows\\System32\\bash.exe";
		writeFileSync(join(root, shellPath), "shell discovery fixture");
		const adapter = vi.fn<LocalProcessSpawn>((request) => localSpawn({ ...request, program: "/bin/bash" }));
		const env = new NodeExecutionEnv({ cwd: root, shellPath, localSpawn: adapter });
		const originalCwd = process.cwd();
		let output = "";
		try {
			process.chdir(root);
			expect(
				getOrThrow(
					await env.exec(
						"printf 'stdin command'",
						{
							onOutput: (text) => {
								output += text;
							},
						},
						BACKGROUND_CONTEXT,
					),
				),
			).toEqual({ exitCode: 0 });
		} finally {
			process.chdir(originalCwd);
		}
		expect(output).toBe("stdin command");
		expect(adapter.mock.calls[0]![0]).toMatchObject({ program: shellPath, args: ["-s"], stdin: "pipe" });
	});

	it.each([
		[{ code: 23, signal: null }, 23],
		[{ code: null, signal: "SIGTERM" }, 143],
	] as const)(
		"uses business status %j instead of the anchor's SIGKILL and waits for result",
		async (status, exitCode) => {
			const started = deferred<ReturnType<LocalProcessSpawn>>();
			const business = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
			const env = new NodeExecutionEnv({
				cwd: tempDir(),
				localSpawn: (request) => {
					const spawned = localSpawn(request);
					started.resolve(spawned);
					return { ...spawned, result: business.promise };
				},
			});
			let settled = false;
			const execution = env
				.exec(
					[process.execPath, "-e", "process.stdout.write('tail');process.kill(process.pid,'SIGKILL')"],
					undefined,
					BACKGROUND_CONTEXT,
				)
				.then((result) => {
					settled = true;
					return result;
				});
			const spawned = await started.promise;
			expect(await spawned.result).toEqual({ code: null, signal: "SIGKILL" });
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(settled).toBe(false);
			business.resolve(status);
			expect(getOrThrow(await execution)).toEqual({ exitCode });
		},
	);

	it("retains adapter cancellation after child close until its result settles", async () => {
		const started = deferred<ReturnType<LocalProcessSpawn>>();
		const business = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
		const env = new NodeExecutionEnv({
			cwd: tempDir(),
			localSpawn: (request) => {
				const spawned = localSpawn(request);
				started.resolve(spawned);
				return { ...spawned, result: business.promise };
			},
		});
		const execution = env.exec([process.execPath, "-e", ""], undefined, BACKGROUND_CONTEXT);
		const spawned = await started.promise;
		await spawned.result;
		await env.cleanup(BACKGROUND_CONTEXT);
		expect(spawned.cancel).toHaveBeenCalledTimes(1);
		business.resolve({ code: 0, signal: null });
		expect(getOrThrow(await execution)).toEqual({ exitCode: 0 });
		await env.cleanup(BACKGROUND_CONTEXT);
		expect(spawned.cancel).toHaveBeenCalledTimes(1);
	});

	it("waits for output completion even if the adapter result resolves early", async () => {
		let output = "";
		const env = new NodeExecutionEnv({
			cwd: tempDir(),
			localSpawn: (request) => ({ ...localSpawn(request), result: Promise.resolve({ code: 17, signal: null }) }),
		});
		const result = await env.exec(
			[process.execPath, "-e", "setTimeout(()=>process.stdout.write('late tail'),150)"],
			{
				onOutput: (text) => {
					output += text;
				},
			},
			BACKGROUND_CONTEXT,
		);
		expect(output).toBe("late tail");
		expect(getOrThrow(result)).toEqual({ exitCode: 17 });
	});

	it("fails closed on synchronous adapter errors without spawning the requested program", async () => {
		const root = tempDir();
		const adapter = vi.fn<LocalProcessSpawn>(() => {
			throw new Error("host unavailable");
		});
		const env = new NodeExecutionEnv({ cwd: root, localSpawn: adapter });
		expect(
			await env.exec(
				[process.execPath, "-e", "require('fs').writeFileSync('unexpected','x')"],
				undefined,
				BACKGROUND_CONTEXT,
			),
		).toMatchObject({ ok: false, error: { code: "spawn_error", message: "host unavailable" } });
		expect(getOrThrow(await env.exists("unexpected", BACKGROUND_CONTEXT))).toBe(false);
	});

	it("handles immediate result rejection, cancels the child and returns a protocol error", async () => {
		const kill = vi.spyOn(process, "kill");
		const env = new NodeExecutionEnv({
			cwd: tempDir(),
			localSpawn: (request) => ({
				...localSpawn(request),
				result: Promise.reject(new Error("invalid result frame")),
			}),
		});
		expect(
			await env.exec([process.execPath, "-e", "setInterval(()=>{},1000)"], undefined, BACKGROUND_CONTEXT),
		).toMatchObject({ ok: false, error: { code: "spawn_error", message: "invalid result frame" } });
		expect(processes[0]!.cancel).toHaveBeenCalledTimes(1);
		expect(kill).not.toHaveBeenCalled();
	});

	it("handles asynchronous child spawn errors and still observes adapter rejection", async () => {
		const env = new NodeExecutionEnv({ cwd: tempDir(), localSpawn });
		expect(await env.exec([join(env.cwd, "missing-program")], undefined, BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
			error: { code: "spawn_error" },
		});
	});

	it.each(["abort", "timeout", "cleanup", "callback"] as const)(
		"routes %s through adapter cancellation, not PGID killing",
		async (mode) => {
			const kill = vi.spyOn(process, "kill");
			const controller = new AbortController();
			const ready = deferred<void>();
			const env = new NodeExecutionEnv({ cwd: tempDir(), localSpawn });
			const execution = env.exec(
				[process.execPath, "-e", "process.stdout.write('ready');setInterval(()=>{},1000)"],
				{
					timeout: mode === "timeout" ? 0.3 : undefined,
					onOutput: () => {
						ready.resolve();
						if (mode === "callback") throw new Error("callback failed");
					},
				},
				withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
			);
			await ready.promise;
			if (mode === "abort") controller.abort();
			if (mode === "cleanup") await env.cleanup(BACKGROUND_CONTEXT);
			const result = await execution;
			if (mode === "cleanup") expect(getOrThrow(result)).toEqual({ exitCode: 137 });
			else
				expect(result).toMatchObject({
					ok: false,
					error: { code: mode === "callback" ? "callback_error" : mode === "abort" ? "aborted" : "timeout" },
				});
			expect(processes[0]!.cancel).toHaveBeenCalledTimes(1);
			expect(kill).not.toHaveBeenCalled();
			await env.cleanup(BACKGROUND_CONTEXT);
			expect(processes[0]!.cancel).toHaveBeenCalledTimes(1);
		},
	);

	it.each(["abort", "timeout"] as const)("preserves %s when cancellation rejects the adapter result", async (mode) => {
		const started = deferred<void>();
		const controller = new AbortController();
		const env = new NodeExecutionEnv({
			cwd: tempDir(),
			localSpawn: (request) => {
				const spawned = localSpawn(request);
				started.resolve();
				return {
					...spawned,
					result: spawned.result.then(() => {
						throw new Error("cancelled before result frame");
					}),
				};
			},
		});
		const execution = env.exec(
			[process.execPath, "-e", "setInterval(()=>{},1000)"],
			{ timeout: mode === "timeout" ? 0.1 : undefined },
			withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
		);
		await started.promise;
		if (mode === "abort") controller.abort();
		expect(await execution).toMatchObject({ ok: false, error: { code: mode === "abort" ? "aborted" : "timeout" } });
	});

	it("does not invoke the adapter for pre-abort, invalid timeout or empty argv", async () => {
		const controller = new AbortController();
		controller.abort();
		const adapter = vi.fn(localSpawn);
		const env = new NodeExecutionEnv({ cwd: tempDir(), localSpawn: adapter });
		expect(
			await env.exec([process.execPath], undefined, withAbortSignal(controller.signal, BACKGROUND_CONTEXT)),
		).toMatchObject({ ok: false, error: { code: "aborted" } });
		expect(await env.exec([process.execPath], { timeout: 0 }, BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
			error: { code: "timeout" },
		});
		expect(await env.exec([], undefined, BACKGROUND_CONTEXT)).toMatchObject({
			ok: false,
			error: { code: "spawn_error" },
		});
		expect(adapter).not.toHaveBeenCalled();
	});

	it("keeps UTF-8 stream decoding and complete raw spill output", async () => {
		let output = "";
		const env = new NodeExecutionEnv({ cwd: tempDir(), localSpawn });
		const script =
			"const b=Buffer.from('😀');process.stdout.write(b.subarray(0,2));setTimeout(()=>{process.stdout.write(b.subarray(2));process.stdout.write(Buffer.alloc(500000,120))},30)";
		const result = getOrThrow(
			await env.exec(
				[process.execPath, "-e", script],
				{
					spill: { afterBytes: 1, afterLines: 10 },
					onOutput: (text) => {
						output += text;
					},
				},
				BACKGROUND_CONTEXT,
			),
		);
		expect(output).toBe(`😀${"x".repeat(500000)}`);
		expect(result.spillPath).toBeDefined();
		roots.push(join(result.spillPath!, ".."));
		expect(readFileSync(result.spillPath!)).toEqual(Buffer.from(output));
	});
});
