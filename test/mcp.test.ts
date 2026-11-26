import { expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
		"check_plan",
		"describe_plan",
		"get_run",
		"list_plans",
		"list_runs",
		"start_plan",
		"submit_stage",
	]);
	const listed = (await call("list_plans")).value as {
		plans: { id: string }[];
		invalid: unknown[];
	};
	expect(listed.plans.map(({ id }) => id)).toContain("goal-pursuit");
	expect(listed.invalid).toEqual([]);
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
	expect(runs[0]).not.toHaveProperty("context");
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

test("the stdio server starts from its config, skips a broken plan file and answers over stdin/stdout", async () => {
	const dir = mkdtempSync(join(tmpdir(), "thought-plan-mcp-"));
	try {
		const config = join(dir, "config.json");
		mkdirSync(join(dir, "plans"));
		writeFileSync(join(dir, "plans", "broken.json"), "{");
		writeFileSync(
			config,
			JSON.stringify({
				ledger: { mode: "full", path: "ledger.sqlite" },
				planDirectories: ["plans"],
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
		expect(JSON.parse(result.content[0]!.text)).toMatchObject({
			invalid: [{ code: "plan_json_invalid" }],
		});
		expect(JSON.parse(result.content[0]!.text).plans).toHaveLength(4);
		expect(client.getServerVersion()?.version).toBe(
			JSON.parse(
				readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"),
			).version,
		);
		await client.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("check_plan reports a plan's shape or the fault's place, and oversized payloads are refused", async () => {
	const { call } = await connect();
	const ok = (await call("check_plan", { document: twoStagePlan })).value;
	expect(ok).toMatchObject({
		ok: true,
		plan: { id: "two-stage", stages: [{ id: "judge" }, { id: "plan" }] },
	});
	const broken = structuredClone(twoStagePlan) as Record<string, any>;
	broken.stages[0].input.later = "$.stages.plan.output.steps";
	expect((await call("check_plan", { document: broken })).value).toEqual({
		ok: false,
		code: "ref_stage_not_before",
		where: "stages[0].input.later",
	});
	const big = "x".repeat(260_000);
	expect(
		await call("start_plan", {
			planId: "two-stage",
			inputs: { question: big, known: false },
		}),
	).toEqual({ error: true, value: { code: "payload_too_large" } });
	const started = (
		await call("start_plan", {
			planId: "two-stage",
			inputs: { question: "q", known: false },
		})
	).value;
	expect(
		await call("submit_stage", {
			runId: started.runId,
			stageId: "judge",
			output: { reason: big },
		}),
	).toEqual({ error: true, value: { code: "payload_too_large" } });
});

test("get_run does not return what a model answered unusably; the ledger keeps it", async () => {
	const { runPlan } = await import("../src/index");
	const { fakeLlm } = await import("./fixture");
	const ledger = createLedger(openLedgerStore(":memory:"));
	const failed = await runPlan(
		loadPlan(twoStagePlan),
		{ question: "q", known: false },
		{ ledger, llm: fakeLlm(() => ({ decision: "maybe" })).llm },
	);
	const { call } = await connect(ledger);
	const run = (await call("get_run", { runId: failed.runId })).value;
	expect(run.stages[0]).toMatchObject({ status: "failed", output: null });
	expect(ledger.readRun(failed.runId)!.stages[0]!.output).toEqual({
		decision: "maybe",
	});
});
