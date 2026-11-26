/**
 * Runs the example scenarios and checks each run.
 *
 *   bun run examples                      every scenario, live, with config/llm.json (OpenAI)
 *   bun run examples -- --scenario a,b    only these
 *   bun run examples:fixture              every scenario with its fixture answers, no model
 *   --ledger off                          record nothing (default: data/examples.sqlite)
 *
 * Stops at the first scenario that fails its checks. Each run is recorded under `subjectRef` `example:<id>`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createLedger,
	openLedgerStore,
	type Ledger,
	type LedgerMode,
} from "../src/ledger";
import type { LlmPort } from "../src/llm";
import type { LoadedPlan } from "../src/plan";
import { bundledPlans, loadPlanDirectory, mergePlans } from "../src/plans";
import { runPlan, type RunResult } from "../src/run";
import {
	createOpenAILlm,
	createSpendMeter,
	readLlmConfig,
} from "../standalone/openai";
import type { Check, Scenario } from "./scenario";
import { generalScenarios } from "./scenarios/general";
import { live2dScenarios } from "./scenarios/live2d-goal";

export const scenarios: readonly Scenario[] = [
	...live2dScenarios,
	...generalScenarios,
];

export const examplePlans = (): LoadedPlan[] =>
	mergePlans(bundledPlans(), loadPlanDirectory(join(import.meta.dir, "plans")));

export function planOf(scenario: Scenario, plans: readonly LoadedPlan[]) {
	const id =
		"bundled" in scenario.plan
			? scenario.plan.bundled
			: scenario.plan.file.replace(/\.json$/, "");
	const plan = plans.find((candidate) => candidate.id === id);
	if (!plan) throw new Error(`example_plan_missing:${id}`);
	return plan;
}

/** A model that answers from the scenario's fixture, keyed by the stage it is asked for. */
export function fixtureLlm(scenario: Scenario, plan: LoadedPlan): LlmPort {
	const stageOf = new Map(plan.stages.map((stage) => [stage.system, stage.id]));
	return {
		async complete(request) {
			const id = stageOf.get(request.system);
			if (!id || !(id in scenario.fixture))
				throw Object.assign(new Error("fixture_stage_missing"), {
					code: "fixture_stage_missing",
				});
			return {
				value: request.schema.parse(scenario.fixture[id]),
				model: "fixture",
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				latencyMs: 0,
			};
		},
	};
}

export type ScenarioReport = {
	readonly id: string;
	readonly ok: boolean;
	readonly result: RunResult;
	readonly checks: readonly Check[];
	readonly modelCalls: number;
	readonly tokens: { input: number; output: number };
};

/** Runs one scenario and checks which stages ran, which were skipped, and the scenario's own checks. */
export async function runScenario(
	scenario: Scenario,
	input: { plan: LoadedPlan; llm: LlmPort; ledger: Ledger },
): Promise<ScenarioReport> {
	let modelCalls = 0;
	const tokens = { input: 0, output: 0 };
	const counted: LlmPort = {
		async complete(request, signal) {
			modelCalls++;
			const receipt = await input.llm.complete(request, signal);
			tokens.input += receipt.inputTokens;
			tokens.output += receipt.outputTokens;
			return receipt;
		},
	};
	const result = await runPlan(input.plan, scenario.inputs, {
		llm: counted,
		ledger: input.ledger,
		subjectRef: `example:${scenario.id}`,
	});
	const ids = (status: string) =>
		result.stages
			.filter((stage) => stage.status === status)
			.map(({ id }) => id);
	const checks: Check[] = [
		{
			name: "実行が完了する",
			ok: result.status === "completed",
			detail: `${result.status}${result.errorCode ? ` ${result.errorCode}` : ""}`,
		},
		{
			name: "動いた段",
			ok: JSON.stringify(ids("ran")) === JSON.stringify(scenario.ran),
			detail: `期待 ${JSON.stringify(scenario.ran)} / 実際 ${JSON.stringify(ids("ran"))}`,
		},
		{
			name: "省いた段",
			ok: JSON.stringify(ids("skipped")) === JSON.stringify(scenario.skipped),
			detail: `期待 ${JSON.stringify(scenario.skipped)} / 実際 ${JSON.stringify(ids("skipped"))}`,
		},
		...(result.status === "completed" ? scenario.checks(result) : []),
	];
	return {
		id: scenario.id,
		ok: checks.every(({ ok }) => ok),
		result,
		checks,
		modelCalls,
		tokens,
	};
}

if (import.meta.main) {
	const arg = (name: string) => {
		const index = process.argv.indexOf(name);
		return index >= 0 ? process.argv[index + 1] : undefined;
	};
	const fixture = process.argv.includes("--fixture");
	const only = arg("--scenario")?.split(",");
	const mode: LedgerMode = arg("--ledger") === "off" ? "off" : "full";
	const selected = only
		? only.map((id) => {
				const found = scenarios.find((scenario) => scenario.id === id);
				if (!found) throw new Error(`example_scenario_unknown:${id}`);
				return found;
			})
		: scenarios;
	const root = join(import.meta.dir, "..");
	const ledger = createLedger(
		mode === "full"
			? openLedgerStore(join(root, "data", "examples.sqlite"))
			: null,
		mode,
	);
	const plans = examplePlans();
	const config = fixture ? null : readLlmConfig();
	const meter = config ? createSpendMeter(config) : null;
	const live = config && meter ? createOpenAILlm(config, meter) : null;
	console.log(
		fixture
			? "mode: fixture"
			: `mode: live ${config!.model} effort=${config!.effort}`,
	);
	const reports: ScenarioReport[] = [];
	let failed = false;
	for (const scenario of selected) {
		const plan = planOf(scenario, plans);
		const report = await runScenario(scenario, {
			plan,
			llm: live ?? fixtureLlm(scenario, plan),
			ledger,
		});
		reports.push(report);
		console.log(
			`\n${report.ok ? "PASS" : "FAIL"} ${scenario.id} (calls ${report.modelCalls}, tokens in ${report.tokens.input} / out ${report.tokens.output}, run ${report.result.runId})`,
		);
		for (const item of report.checks)
			console.log(
				`  ${item.ok ? "ok  " : "NG  "} ${item.name}: ${item.detail}`,
			);
		if (!report.ok) {
			failed = true;
			break;
		}
	}
	const at = new Date().toISOString().replace(/[:.]/g, "-");
	mkdirSync(join(root, "data", "examples"), { recursive: true });
	const file = join(root, "data", "examples", `report-${at}.json`);
	writeFileSync(
		file,
		`${JSON.stringify(
			{
				mode: fixture ? "fixture" : "live",
				model: config ? { model: config.model, effort: config.effort } : null,
				spend: meter?.summary() ?? null,
				reports,
			},
			null,
			"\t",
		)}\n`,
	);
	console.log(
		`\n${reports.filter(({ ok }) => ok).length}/${selected.length} passed${meter ? `, $${meter.summary().spentUsd.toFixed(4)} over ${meter.summary().calls} calls` : ""}. Report: ${file}`,
	);
	process.exit(failed ? 1 : 0);
}
