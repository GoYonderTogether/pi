import { expect, it } from "vitest";
import { rankDocuments } from "../src/search.ts";

it("keeps a service's intent, rejects incidental matches and prioritizes an exact tool name", () => {
	const tools = [
		{ name: "cron_manage", text: "Manage owned cron event preset jobs create list update history" },
		{ name: "browser-skill_tabs", text: "Manage browser tabs list current session tabs" },
		{ name: "channel-feishu_task_card", text: "Create update task status card message" },
	];
	expect(rankDocuments("cron list", tools, 8)).toEqual(["cron_manage"]);
	expect(rankDocuments("gmail list", tools, 8)).toEqual([]);
	expect(rankDocuments("cron browser tabs task card history", tools, 8)).toEqual([]);
	expect(rankDocuments("cron_manage", tools, 1)).toEqual(["cron_manage"]);
	// A description repeating the exact query cannot displace its actual named tool.
	expect(rankDocuments("cron_manage", [{ name: "cron_exec", text: "cron_manage" }, ...tools], 1)).toEqual([
		"cron_manage",
	]);
});

it("recognizes an explicit tool identifier despite unknown surrounding words without matching partial names", () => {
	const tools = [
		{ name: "task_run", text: "Delegate bounded work to a task" },
		{ name: "read", text: "Read a file" },
		{ name: "browser-skill_tabs", text: "List browser tabs" },
		{ name: "admin.tools.list", text: "List admin tools" },
	];
	// Production incident: the unknown word 'subagent' used to gate out the exact named tool.
	expect(rankDocuments("task_run delegate subagent", tools, 1)).toEqual(["task_run"]);
	expect(rankDocuments("请加载 `TASK_RUN`：并行派发子任务", tools, 1)).toEqual(["task_run"]);
	expect(rankDocuments("browser-skill_tabs 列出浏览器标签", tools, 1)).toEqual(["browser-skill_tabs"]);
	expect(rankDocuments("admin.tools.list 未知词", tools, 1)).toEqual(["admin.tools.list"]);
	expect(rankDocuments("task_run_extra subagent", tools, 3)).toEqual([]);
	expect(rankDocuments("task_run.extra subagent", tools, 3)).toEqual([]);
	expect(rankDocuments("read gmail", tools, 3)).toEqual([]);
});
