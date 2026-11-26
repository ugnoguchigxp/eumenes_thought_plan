import { expect, test } from "bun:test";
import { loadPlan, PlanError } from "../src/index";
import { twoStagePlan } from "./fixture";

const clone = () => structuredClone(twoStagePlan) as Record<string, any>;

function refused(mutate: (plan: Record<string, any>) => void, code: string) {
	const plan = clone();
	mutate(plan);
	let caught: unknown;
	try {
		loadPlan(plan);
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(PlanError);
	expect((caught as PlanError).code).toBe(code);
}

test("a valid plan loads with a stable content digest", () => {
	const plan = loadPlan(twoStagePlan);
	expect(plan.stages.map(({ id }) => id)).toEqual(["judge", "plan"]);
	expect(plan.stages[0]!.maxOutputTokens).toBe(1600);
	const reordered = loadPlan(
		JSON.stringify(Object.fromEntries(Object.entries(twoStagePlan).reverse())),
	);
	expect(reordered.digest).toBe(plan.digest);
});

test("references must name declared inputs and earlier stages", () => {
	refused(
		(p) => (p.stages[0].input.question = "$.inputs.missing"),
		"ref_input_unknown",
	);
	refused(
		(p) => (p.stages[0].input.later = "$.stages.plan.output.steps"),
		"ref_stage_not_before",
	);
	refused(
		(p) => (p.stages[0].input.question = "inputs.question"),
		"ref_invalid",
	);
	refused(
		(p) => (p.stages[1].runWhen.path = "$.stages.judge.output.decison"),
		"ref_path_unknown",
	);
});

test("schemas stay within the structured-output subset", () => {
	refused(
		(p) => (p.stages[0].output.properties.reason.pattern = "^a"),
		"schema_keyword_unsupported",
	);
	refused(
		(p) => (p.inputs.question = { type: "date" }),
		"schema_type_unsupported",
	);
	refused((p) => (p.inputs.list = { type: "array" }), "schema_items_missing");
	refused(
		(p) => (p.stages[0].output.required = ["decision"]),
		"output_schema_not_strict",
	);
	refused(
		(p) => delete p.stages[0].output.additionalProperties,
		"output_schema_not_strict",
	);
	refused(
		(p) => (p.stages[0].output = { type: "string" }),
		"output_schema_not_object",
	);
	refused(
		(p) =>
			(p.schemas = {
				a: { $ref: "#/schemas/b" },
				b: { $ref: "#/schemas/a" },
			}),
		"schema_ref_cycle",
	);
	refused(
		(p) => (p.inputs.question = { $ref: "#/schemas/none" }),
		"schema_ref_unknown",
	);
});

test("the document shape is closed and bounded", () => {
	refused((p) => (p.extra = true), "plan_key_unknown");
	refused((p) => (p.stages[1].id = "judge"), "stage_id_duplicate");
	refused((p) => (p.stages = []), "plan_stages_invalid");
	refused(
		(p) =>
			(p.stages = Array.from({ length: 17 }, (_, i) => ({
				...p.stages[0],
				id: `s${i}`,
			}))),
		"plan_stages_invalid",
	);
	refused((p) => (p.stages[0].maxOutputTokens = 0), "stage_tokens_invalid");
	refused((p) => (p.stages[0].system = " "), "stage_system_invalid");
	refused(
		(p) => (p.stages[0].skipWhen = { path: "$.inputs.known" }),
		"condition_invalid",
	);
	refused((p) => (p.outputs = {}), "plan_outputs_missing");
	refused((p) => (p.id = "Two"), "plan_id_invalid");
	expect(() => loadPlan("{")).toThrow(PlanError);
});
