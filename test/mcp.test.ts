import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createThoughtPlanServer } from "../mcp/tools";
import {
	bundledPlans,
	createLedger,
	loadPlan,
	openLedgerStore,
} from "../src/index";
import { twoStagePlan } from "./fixture";

async function connect(ledger = createLedger(openLedgerStore(":memory:"))) {
	const server = createThoughtPlanServer({
		plans: [...bundledPlans(), loadPlan(twoStagePlan)],
		ledger,
	});
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "1.0.0" });
	await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
	const call = async (name: string, args: Record<string, unknown> = {}) => {
		const result = (await client.callTool({ name, arguments: args })) as {
			content: { type: string; text: string }[];
			isError?: boolean;
		};
		return {
			error: result.isError === true,
			value: JSON.parse(result.content[0]!.text),
		};
	};
	return { client, call };
}

test("an agent lists, starts, submits and reads a run through MCP", async () => {
	const { client, call } = await connect();
	const tools = (await client.listTools()).tools.map(({ name }) => name).sort();
	expect(tools).toEqual([
		"cancel_run",
		"describe_plan",
		"get_run",
		"list_plans",
		"list_runs",
		"start_plan",
		"submit_stage",
	]);
	const listed = (await call("list_plans")).value as { id: string }[];
	expect(listed.map(({ id }) => id)).toContain("review-judge-plan");
	const described = (await call("describe_plan", { planId: "two-stage" }))
		.value;
	expect(described.stages[0]).toMatchObject({
		id: "judge",
		skipWhen: { path: "$.inputs.known", equals: true },
	});

	const started = (
		await call("start_plan", {
			planId: "two-stage",
			inputs: { question: "背景色", known: false },
			subjectRef: "task:mcp",
		})
	).value;
	expect(started).toMatchObject({ status: "awaiting", stage: { id: "judge" } });

	const rejected = await call("submit_stage", {
		runId: started.runId,
		stageId: "judge",
		output: { decision: "maybe", reason: "" },
	});
	expect(rejected.value).toMatchObject({
		status: "rejected",
		code: "stage_output_invalid",
	});
	expect(rejected.value.issues.length).toBeGreaterThan(0);

	await call("submit_stage", {
		runId: started.runId,
		stageId: "judge",
		output: { decision: "go", reason: "可能" },
	});
	const done = (
		await call("submit_stage", {
			runId: started.runId,
			stageId: "plan",
			output: { steps: ["読む"] },
		})
	).value;
	expect(done).toMatchObject({
		status: "completed",
		outputs: { decision: "go", steps: ["読む"] },
	});

	const run = (await call("get_run", { runId: started.runId })).value;
	expect(run.stages.map((s: { status: string }) => s.status)).toEqual([
		"rejected",
		"ran",
		"ran",
	]);
	const runs = (await call("list_runs", { subjectRef: "task:mcp" })).value;
	expect(runs).toHaveLength(1);
	expect(runs[0]).not.toHaveProperty("inputs");
});

test("errors come back as codes", async () => {
	const { call } = await connect();
	expect(await call("describe_plan", { planId: "none" })).toEqual({
		error: true,
		value: { code: "plan_unknown", detail: "none" },
	});
	const bad = await call("start_plan", {
		planId: "two-stage",
		inputs: { question: 1, known: false },
	});
	expect(bad.error).toBe(true);
	expect(bad.value.code).toBe("inputs_invalid");
});

test("the stdio server starts from its config and answers over stdin/stdout", async () => {
	const dir = mkdtempSync(join(tmpdir(), "thought-plan-mcp-"));
	try {
		const config = join(dir, "config.json");
		writeFileSync(
			config,
			JSON.stringify({
				ledger: { mode: "full", path: "ledger.sqlite" },
				planDirectories: [],
			}),
		);
		const transport = new StdioClientTransport({
			command: process.execPath,
			args: [
				join(import.meta.dir, "..", "mcp", "server.ts"),
				"--config",
				config,
			],
		});
		const client = new Client({ name: "stdio-test", version: "1.0.0" });
		await client.connect(transport);
		const result = (await client.callTool({
			name: "list_plans",
			arguments: {},
		})) as {
			content: { text: string }[];
		};
		expect(JSON.parse(result.content[0]!.text).length).toBe(4);
		await client.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
