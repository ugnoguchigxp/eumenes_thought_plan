/**
 * Runs the example scenarios and checks each run.
 *
 *   bun run examples                          tuning scenarios once each, live (config/llm.json); stops at the first failure
 *   bun run examples -- --scenario a,b        only these
 *   bun run examples -- --set heldout         the held-out scenarios (`all` for both)
 *   bun run examples -- --repeat 30 --concurrency 4
 *                                             measure: every scenario 30 times, no stop, pass rates per plan version
 *   bun run examples:fixture                  every scenario with its fixture answers, no model, no report file
 *   --ledger off                              record nothing (default: data/examples.sqlite)
 *
 * Each run is recorded under `subjectRef` `example:<id>` with the scenario and model effort as its context.
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
import { continuePlan, runPlan, type RunResult } from "../src/run";
import {
	createOpenAILlm,
	createSpendMeter,
	readLlmConfig,
} from "../standalone/openai";
import type { Check, Scenario } from "./scenario";
import { generalScenarios } from "./scenarios/general";
import { goalPursuitScenarios } from "./scenarios/goal-pursuit";
import { heldoutScenarios } from "./scenarios/heldout";
import { live2dScenarios } from "./scenarios/live2d-goal";

export const scenarios: readonly Scenario[] = [
	...goalPursuitScenarios,
	...live2dScenarios,
	...generalScenarios,
	...heldoutScenarios,
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

/**
 * A model that answers from the scenario's fixtures, keyed by the stage it is asked for: a stage asked again in
 * a later round takes the next round's answer for it.
 */
export function fixtureLlm(scenario: Scenario, plan: LoadedPlan): LlmPort {
	const stageOf = new Map(plan.stages.map((stage) => [stage.system, stage.id]));
	const queues = new Map<string, unknown[]>();
	for (const fixture of [
		scenario.fixture,
		...(scenario.rounds ?? []).map(({ fixture }) => fixture),
	])
		for (const [id, answer] of Object.entries(fixture))
			queues.set(id, [...(queues.get(id) ?? []), answer]);
	return {
		async complete(request) {
			const id = stageOf.get(request.system);
			const queue = id ? queues.get(id) : undefined;
			if (!queue?.length)
				throw Object.assign(new Error("fixture_stage_missing"), {
					code: "fixture_stage_missing",
				});
			return {
				value: request.schema.parse(queue.shift()),
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
	input: {
		plan: LoadedPlan;
		llm: LlmPort;
		ledger: Ledger;
		context?: Record<string, unknown>;
	},
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
		context: { scenario: scenario.id, set: scenario.set, ...input.context },
	});
	const roundChecks = (
		at: RunResult,
		expected: { ran: readonly string[]; skipped: readonly string[] },
		own: ((result: RunResult) => readonly Check[]) | undefined,
		label: string,
	): Check[] => {
		const ids = (status: string) =>
			at.stages.filter((stage) => stage.status === status).map(({ id }) => id);
		return [
			{
				name: `${label}実行が完了する`,
				ok: at.status === "completed",
				detail: `${at.status}${at.errorCode ? ` ${at.errorCode}` : ""}`,
			},
			{
				name: `${label}動いた段`,
				ok: JSON.stringify(ids("ran")) === JSON.stringify(expected.ran),
				detail: `期待 ${JSON.stringify(expected.ran)} / 実際 ${JSON.stringify(ids("ran"))}`,
			},
			{
				name: `${label}省いた段`,
				ok: JSON.stringify(ids("skipped")) === JSON.stringify(expected.skipped),
				detail: `期待 ${JSON.stringify(expected.skipped)} / 実際 ${JSON.stringify(ids("skipped"))}`,
			},
			...(at.status === "completed" && own ? own(at) : []),
		];
	};
	const checks: Check[] = roundChecks(result, scenario, scenario.checks, "");
	// Each later round continues the same run and session with what the executed step returned.
	let last = result;
	for (const [index, round] of (scenario.rounds ?? []).entries()) {
		if (!last.state) break;
		last = await continuePlan(input.plan, last.state, round.input, {
			llm: counted,
			ledger: input.ledger,
		});
		checks.push(
			...roundChecks(last, round, round.checks, `ラウンド${index + 2}: `),
		);
	}
	if (scenario.rounds?.length && last.round !== scenario.rounds.length + 1)
		checks.push({
			name: "すべてのラウンドを実行する",
			ok: false,
			detail: `ラウンド${last.round}で止まった`,
		});
	return {
		id: scenario.id,
		ok: checks.every(({ ok }) => ok),
		result,
		checks,
		modelCalls,
		tokens,
	};
}

/** One scenario measured over repeated runs. */
export type Measurement = {
	readonly id: string;
	readonly set: Scenario["set"];
	readonly plan: { id: string; version: number; digest: string };
	/** Runs the model answered; runs it never answered (connection, rate, spend, settings) are not counted. */
	readonly runs: number;
	readonly passed: number;
	readonly unanswered: number;
	readonly unansweredCodes: Record<string, number>;
	/** How often each check failed, by name. */
	readonly failedChecks: Record<string, number>;
	readonly failedRunIds: readonly string[];
	readonly modelCalls: number;
	readonly tokens: { input: number; output: number };
};

/** Failures where the model never answered: they say nothing about the plan. */
const setupCodes = new Set([
	"llm_spend_limit",
	"llm_api_key_missing",
	"llm_price_missing",
	"llm_model_not_confirmed",
]);
export const unanswered = (report: ScenarioReport) =>
	report.result.failure !== null &&
	(report.result.failure.retryable ||
		setupCodes.has(report.result.failure.code));

export function summarize(
	scenario: Scenario,
	plan: LoadedPlan,
	all: readonly ScenarioReport[],
): Measurement {
	const reports = all.filter((report) => !unanswered(report));
	const unansweredCodes: Record<string, number> = {};
	for (const report of all)
		if (unanswered(report)) {
			const code = report.result.failure!.code;
			unansweredCodes[code] = (unansweredCodes[code] ?? 0) + 1;
		}
	const failedChecks: Record<string, number> = {};
	for (const report of reports)
		for (const item of report.checks)
			if (!item.ok)
				failedChecks[item.name] = (failedChecks[item.name] ?? 0) + 1;
	return {
		id: scenario.id,
		set: scenario.set,
		plan: { id: plan.id, version: plan.version, digest: plan.digest },
		runs: reports.length,
		passed: reports.filter(({ ok }) => ok).length,
		unanswered: all.length - reports.length,
		unansweredCodes,
		failedChecks,
		failedRunIds: reports
			.filter(({ ok }) => !ok)
			.map(({ result }) => result.runId),
		modelCalls: all.reduce((sum, { modelCalls }) => sum + modelCalls, 0),
		tokens: {
			input: all.reduce((sum, { tokens }) => sum + tokens.input, 0),
			output: all.reduce((sum, { tokens }) => sum + tokens.output, 0),
		},
	};
}

/** Runs the tasks with at most `limit` in flight; stops starting new ones once `stop()` is true. */
async function pool<T>(
	tasks: readonly (() => Promise<T>)[],
	limit: number,
	stop: () => boolean,
): Promise<T[]> {
	const results: T[] = [];
	let next = 0;
	const worker = async () => {
		while (next < tasks.length && !stop()) {
			const index = next++;
			results[index] = await tasks[index]!();
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(limit, tasks.length) }, worker),
	);
	return results.filter((result) => result !== undefined);
}

if (import.meta.main) {
	const arg = (name: string) => {
		const index = process.argv.indexOf(name);
		if (index < 0) return undefined;
		const value = process.argv[index + 1];
		if (value === undefined || value.startsWith("--"))
			throw new Error(`example_argument_missing:${name}`);
		return value;
	};
	const count = (name: string, fallback: number, min: number) => {
		const value = Number(arg(name) ?? fallback);
		if (!Number.isInteger(value) || value < min)
			throw new Error(`example_argument_invalid:${name}`);
		return value;
	};
	const fixture = process.argv.includes("--fixture");
	const repeat = count("--repeat", 0, 0);
	const concurrency = count("--concurrency", 4, 1);
	const set = arg("--set") ?? (fixture ? "all" : "tuning");
	const only = arg("--scenario")?.split(",");
	const mode: LedgerMode = arg("--ledger") === "off" ? "off" : "full";
	if (!["tuning", "heldout", "all"].includes(set))
		throw new Error(`example_set_unknown:${set}`);
	const selected = only
		? only.map((id) => {
				const found = scenarios.find((scenario) => scenario.id === id);
				if (!found) throw new Error(`example_scenario_unknown:${id}`);
				return found;
			})
		: scenarios.filter((scenario) => set === "all" || scenario.set === set);
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
	const context = config ? { effort: config.effort } : { effort: "fixture" };
	console.log(
		fixture
			? "mode: fixture"
			: `mode: live ${config!.model} effort=${config!.effort}${repeat ? ` repeat=${repeat} concurrency=${concurrency}` : ""}`,
	);
	const once = (scenario: Scenario) => {
		const plan = planOf(scenario, plans);
		return runScenario(scenario, {
			plan,
			llm: live ?? fixtureLlm(scenario, plan),
			ledger,
			context,
		});
	};
	const print = (report: ScenarioReport) => {
		console.log(
			`\n${report.ok ? "PASS" : "FAIL"} ${report.id} (calls ${report.modelCalls}, tokens in ${report.tokens.input} / out ${report.tokens.output}, run ${report.result.runId})`,
		);
		for (const item of report.checks)
			console.log(
				`  ${item.ok ? "ok  " : "NG  "} ${item.name}: ${item.detail}`,
			);
	};
	let failed = false;
	let written: Record<string, unknown>;
	if (repeat > 0) {
		const measured: Measurement[] = [];
		// Past the spend limit every further run fails without asking the model: stop instead of counting them.
		let stopped: string | null = null;
		const watch = (report: ScenarioReport) => {
			if (report.result.failure?.code === "llm_spend_limit")
				stopped = "llm_spend_limit";
			return report;
		};
		for (const scenario of selected) {
			if (stopped) break;
			const first = watch(await once(scenario));
			// A scenario that asks the model nothing measures the conditions only: once is enough.
			const rest =
				first.modelCalls === 0 || fixture
					? []
					: await pool(
							Array.from(
								{ length: repeat - 1 },
								() => async () => watch(await once(scenario)),
							),
							concurrency,
							() => stopped !== null,
						);
			const summary = summarize(scenario, planOf(scenario, plans), [
				first,
				...rest,
			]);
			measured.push(summary);
			console.log(
				`${summary.passed}/${summary.runs} ${scenario.id} [${scenario.set}] ${summary.plan.id}@${summary.plan.version}${first.modelCalls === 0 ? " (推論0回・集計外)" : ""}${summary.unanswered ? ` 未応答 ${JSON.stringify(summary.unansweredCodes)}` : ""}${Object.keys(summary.failedChecks).length ? ` NG ${JSON.stringify(summary.failedChecks)}` : ""}`,
			);
		}
		const counted = measured.filter(({ modelCalls }) => modelCalls > 0);
		const rate = (list: readonly Measurement[]) => {
			const runs = list.reduce((sum, { runs }) => sum + runs, 0);
			const passed = list.reduce((sum, { passed }) => sum + passed, 0);
			return { runs, passed, rate: runs ? passed / runs : null };
		};
		// Per set and plan version: a rate never mixes plan bodies.
		const byVersion: Record<string, ReturnType<typeof rate>> = {};
		for (const key of new Set(
			counted.map(({ set, plan }) => `${set} ${plan.id}@${plan.version}`),
		))
			byVersion[key] = rate(
				counted.filter(
					({ set, plan }) => `${set} ${plan.id}@${plan.version}` === key,
				),
			);
		const totals = {
			tuning: rate(counted.filter(({ set }) => set === "tuning")),
			heldout: rate(counted.filter(({ set }) => set === "heldout")),
			byVersion,
		};
		console.log(`\n${JSON.stringify(totals, null, 1)}`);
		if (stopped) {
			console.log(`stopped: ${stopped}`);
			failed = true;
		}
		written = { scenarios: measured, totals, stopped };
	} else {
		const reports: ScenarioReport[] = [];
		for (const scenario of selected) {
			const report = await once(scenario);
			reports.push(report);
			print(report);
			if (!report.ok) {
				failed = true;
				break;
			}
		}
		console.log(
			`\n${reports.filter(({ ok }) => ok).length}/${selected.length} passed`,
		);
		written = { reports };
	}
	if (meter)
		console.log(
			`$${meter.summary().spentUsd.toFixed(4)} over ${meter.summary().calls} calls`,
		);
	// Fixture runs only print: the report directory holds live measurements.
	if (!fixture) {
		const at = new Date().toISOString().replace(/[:.]/g, "-");
		mkdirSync(join(root, "data", "examples"), { recursive: true });
		const file = join(root, "data", "examples", `report-${at}.json`);
		writeFileSync(
			file,
			`${JSON.stringify(
				{
					mode: "live",
					model: { model: config!.model, effort: config!.effort },
					spend: meter!.summary(),
					...written,
				},
				null,
				"\t",
			)}\n`,
		);
		console.log(`Report: ${file}`);
	}
	process.exit(failed ? 1 : 0);
}
