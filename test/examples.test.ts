import { expect, test } from "bun:test";
import { zodTextFormat } from "openai/helpers/zod";
import {
	examplePlans,
	fixtureLlm,
	planOf,
	runScenario,
	scenarios,
} from "../examples/run";
import { createLedger, openLedgerStore } from "../src/index";
import {
	createSpendMeter,
	openAIKey,
	readLlmConfig,
} from "../standalone/openai";

const plans = examplePlans();

for (const scenario of scenarios)
	test(`scenario ${scenario.id} passes its checks with its fixture answers`, async () => {
		const plan = planOf(scenario, plans);
		const report = await runScenario(scenario, {
			plan,
			llm: fixtureLlm(scenario, plan),
			ledger: createLedger(openLedgerStore(":memory:")),
		});
		expect(report.checks.filter(({ ok }) => !ok)).toEqual([]);
		expect(report.modelCalls).toBe(scenario.ran.length);
	});

test("every stage schema converts to a strict structured-output format", () => {
	for (const plan of plans)
		for (const stage of plan.stages) {
			const format = zodTextFormat(stage.outputSchema, "stage_output");
			expect(format.strict).toBe(true);
			expect((format.schema as { type?: string }).type).toBe("object");
		}
});

test("the model settings parse and every configured model has a price", () => {
	const config = readLlmConfig();
	expect(config.provider).toBe("openai");
	expect(() => createSpendMeter(config)).not.toThrow();
	const meter = createSpendMeter({
		...config,
		spend: { ...config.spend, limitUsd: 0.000001 },
	});
	meter.record(config.model, { input: 1000, cached: 0, output: 1000 });
	expect(() => meter.assertWithinLimit()).toThrow("llm_spend_limit");
});

test("the API key comes from the exported variables only", () => {
	expect(openAIKey({ OPEN_AI_API_KEY: " k1 ", OPENAI_API_KEY: "k2" })).toBe(
		"k1",
	);
	expect(openAIKey({ OPENAI_API_KEY: "k2" })).toBe("k2");
	expect(() => openAIKey({})).toThrow("llm_api_key_missing");
});

test("each call is stateless and carries its stage's prompt-cache key; cached input is reported", async () => {
	const { createOpenAILlm, promptCacheKey } =
		await import("../standalone/openai");
	const config = readLlmConfig();
	const sent: Record<string, unknown>[] = [];
	const client = {
		responses: {
			async create(body: Record<string, unknown>) {
				sent.push(body);
				return {
					id: "resp",
					model: config.model,
					status: "completed",
					output: [
						{
							type: "message",
							content: [{ type: "output_text", text: '{"ok":true}' }],
						},
					],
					usage: {
						input_tokens: 2000,
						input_tokens_details: { cached_tokens: 1536 },
						output_tokens: 10,
					},
				};
			},
		},
	};
	const llm = createOpenAILlm(
		config,
		createSpendMeter(config),
		client as unknown as import("openai").default,
	);
	const { z } = await import("zod");
	const schema = z.strictObject({ ok: z.boolean() });
	const ask = (system: string) =>
		llm.complete(
			{ purpose: "think", system, prompt: "{}", schema, maxOutputTokens: 100 },
			new AbortController().signal,
		);
	const first = await ask("振り返る。");
	await ask("振り返る。");
	await ask("計画する。");
	expect(first.cacheReadTokens).toBe(1536);
	expect(sent.map((body) => body.prompt_cache_key)).toEqual([
		promptCacheKey("振り返る。"),
		promptCacheKey("振り返る。"),
		promptCacheKey("計画する。"),
	]);
	expect(sent[0]).toMatchObject({ store: false, model: config.model });
	expect(sent[0]).not.toHaveProperty("previous_response_id");
});

test("measurement aggregates repeated runs per scenario with the plan version", async () => {
	const { summarize } = await import("../examples/run");
	const scenario = scenarios.find(({ id }) => id === "triage-typo")!;
	const plan = planOf(scenario, plans);
	const reports = await Promise.all(
		[0, 1, 2].map(() =>
			runScenario(scenario, {
				plan,
				llm: fixtureLlm(scenario, plan),
				ledger: createLedger(openLedgerStore(":memory:")),
			}),
		),
	);
	const failing = {
		...reports[0]!,
		ok: false,
		checks: [{ name: "閉じない", ok: false, detail: "" }],
	};
	expect(summarize(scenario, plan, [...reports, failing])).toMatchObject({
		id: "triage-typo",
		set: "tuning",
		plan: { id: "code-triage", version: 1, digest: plan.digest },
		runs: 4,
		passed: 3,
		failedChecks: { 閉じない: 1 },
		modelCalls: 8,
	});
});

test("scenarios are split into a tuning set and a held-out set", () => {
	const count = (set: string) => scenarios.filter((s) => s.set === set).length;
	expect(count("tuning")).toBe(10);
	expect(count("heldout")).toBe(12);
	expect(new Set(scenarios.map(({ id }) => id)).size).toBe(scenarios.length);
});

test("runs the model never answered are reported apart, not counted as plan failures", async () => {
	const { summarize } = await import("../examples/run");
	const scenario = scenarios.find(({ id }) => id === "triage-typo")!;
	const plan = planOf(scenario, plans);
	const ok = await runScenario(scenario, {
		plan,
		llm: fixtureLlm(scenario, plan),
		ledger: createLedger(openLedgerStore(":memory:")),
	});
	const limited = await runScenario(scenario, {
		plan,
		llm: {
			async complete() {
				throw Object.assign(new Error("x"), {
					code: "llm_spend_limit",
					retryable: false,
				});
			},
		},
		ledger: createLedger(openLedgerStore(":memory:")),
	});
	expect(summarize(scenario, plan, [ok, limited])).toMatchObject({
		runs: 1,
		passed: 1,
		unanswered: 1,
		unansweredCodes: { llm_spend_limit: 1 },
	});
});
