import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { PlanError, RunError } from "../src/errors";
import type { Ledger } from "../src/ledger";
import type { LoadedPlan } from "../src/plan";
import { createStepRunner } from "../src/run";
import { inlineRefs } from "../src/schema";

export const SERVER_NAME = "eumenes-thought-plan";
export const SERVER_VERSION = "0.1.0";

/** The newest version of each plan id, plus every version by `id@version`. */
function catalog(plans: readonly LoadedPlan[]) {
	const exact = new Map(
		plans.map((plan) => [`${plan.id}@${plan.version}`, plan]),
	);
	const latest = new Map<string, LoadedPlan>();
	for (const plan of plans) {
		const seen = latest.get(plan.id);
		if (!seen || seen.version < plan.version) latest.set(plan.id, plan);
	}
	return (id: string, version?: number) =>
		version === undefined ? latest.get(id) : exact.get(`${id}@${version}`);
}

/** The plan as a caller reads it: schemas inlined, conditions as written in the document. */
function describe(plan: LoadedPlan) {
	const document = plan.document as {
		stages: { runWhen?: unknown; skipWhen?: unknown; input?: unknown }[];
		outputs: unknown;
	};
	return {
		id: plan.id,
		version: plan.version,
		digest: plan.digest,
		description: plan.description,
		inputs: Object.fromEntries(
			Object.entries(plan.inputs).map(([name, schema]) => [
				name,
				inlineRefs(schema, plan.schemas),
			]),
		),
		stages: plan.stages.map((stage, i) => ({
			id: stage.id,
			description: stage.description,
			input: document.stages[i]?.input ?? {},
			runWhen: document.stages[i]?.runWhen ?? null,
			skipWhen: document.stages[i]?.skipWhen ?? null,
			outputSchema: inlineRefs(stage.output, plan.schemas),
		})),
		outputs: document.outputs,
	};
}

const text = (value: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(value) }],
});
const failure = (code: string, detail?: string) => ({
	isError: true,
	content: [
		{
			type: "text" as const,
			text: JSON.stringify(detail ? { code, detail } : { code }),
		},
	],
});
function caught(error: unknown) {
	if (error instanceof RunError) return failure(error.code, error.detail);
	if (error instanceof PlanError) return failure(error.code, error.where);
	return failure("thought_plan_failed");
}

const json = z.unknown();

/**
 * The MCP server. It does not call a model: the calling agent thinks each stage out itself and submits the
 * output, which the server checks against the stage's schema, records and wires on.
 */
export function createThoughtPlanServer(input: {
	readonly plans: readonly LoadedPlan[];
	readonly ledger: Ledger;
}) {
	const find = catalog(input.plans);
	const runner = createStepRunner({ ledger: input.ledger });
	const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

	server.registerTool(
		"list_plans",
		{
			description:
				"List the thought plans available: each is a fixed sequence of thinking stages with typed inputs and outputs.",
			inputSchema: z.object({}).strict(),
		},
		async () =>
			text(
				[...new Set(input.plans.map(({ id }) => id))].map((id) => {
					const plan = find(id)!;
					return {
						id: plan.id,
						version: plan.version,
						description: plan.description,
					};
				}),
			),
	);

	server.registerTool(
		"describe_plan",
		{
			description:
				"Show a plan's inputs, stages (with the conditions that skip them) and outputs, schemas inlined.",
			inputSchema: z
				.object({
					planId: z.string(),
					version: z.number().int().min(1).optional(),
				})
				.strict(),
		},
		async ({ planId, version }) => {
			const plan = find(planId, version);
			return plan ? text(describe(plan)) : failure("plan_unknown", planId);
		},
	);

	server.registerTool(
		"start_plan",
		{
			description:
				"Start a run of a plan with its inputs. Returns the first stage to think out: its system context, its input and the JSON Schema its output must match. Stages whose conditions skip them are skipped without thinking. Think the stage out yourself following its system context, then call submit_stage.",
			inputSchema: z
				.object({
					planId: z.string(),
					version: z.number().int().min(1).optional(),
					inputs: z.record(z.string(), json),
					subjectRef: z.string().max(512).optional(),
				})
				.strict(),
		},
		async ({ planId, version, inputs, subjectRef }) => {
			const plan = find(planId, version);
			if (!plan) return failure("plan_unknown", planId);
			try {
				return text(
					await runner.start(plan, inputs, { subjectRef: subjectRef ?? null }),
				);
			} catch (error) {
				return caught(error);
			}
		},
	);

	server.registerTool(
		"submit_stage",
		{
			description:
				"Submit your output for the stage the run waits for. The output is checked against the stage's schema: on a mismatch the stage does not advance and the issues are returned. Otherwise the next stage is returned, or the plan's outputs when the run is complete.",
			inputSchema: z
				.object({
					runId: z.string(),
					stageId: z.string(),
					output: json,
				})
				.strict(),
		},
		async ({ runId, stageId, output }) => {
			try {
				return text(await runner.submit(runId, stageId, output));
			} catch (error) {
				return caught(error);
			}
		},
	);

	server.registerTool(
		"get_run",
		{
			description:
				"Show a run: the stage it waits for or its outputs, and (with the ledger on) every recorded stage with its input and output.",
			inputSchema: z.object({ runId: z.string() }).strict(),
		},
		async ({ runId }) => {
			try {
				const view = await runner.view(runId);
				const recorded = input.ledger.readRun(runId);
				return text(
					recorded
						? { view, run: recorded.run, stages: recorded.stages }
						: { view },
				);
			} catch (error) {
				return caught(error);
			}
		},
	);

	server.registerTool(
		"list_runs",
		{
			description:
				"List recent runs from the ledger, newest first. Empty when the ledger is off.",
			inputSchema: z
				.object({
					planId: z.string().optional(),
					subjectRef: z.string().optional(),
					limit: z.number().int().min(1).max(200).optional(),
				})
				.strict(),
		},
		async ({ planId, subjectRef, limit }) => {
			try {
				return text(
					input.ledger
						.listRuns({
							...(planId !== undefined && { planId }),
							...(subjectRef !== undefined && { subjectRef }),
							...(limit !== undefined && { limit }),
						})
						.map(({ inputs: _inputs, outputs: _outputs, ...run }) => run),
				);
			} catch (error) {
				return caught(error);
			}
		},
	);

	server.registerTool(
		"cancel_run",
		{
			description: "Stop a run that is waiting for a stage.",
			inputSchema: z.object({ runId: z.string() }).strict(),
		},
		async ({ runId }) => {
			try {
				return text(await runner.cancel(runId));
			} catch (error) {
				return caught(error);
			}
		},
	);

	return server;
}
