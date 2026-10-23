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
