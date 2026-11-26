import { createHash } from "node:crypto";
import { z } from "zod";
import { parseCondition, type Condition } from "./conditions";
import { PlanError } from "./errors";
import { checkRefPath, parseRef, type Ref } from "./refs";
import {
	checkRefCycles,
	checkSchema,
	checkStrict,
	EXPANDED_SCHEMA_LIMIT,
	expandedSize,
	resolveRef,
	toZod,
	type JsonSchema,
} from "./schema";

export const PLAN_LIMITS = {
	stages: 16,
	documentCharacters: 256_000,
	systemCharacters: 32_000,
	maxOutputTokens: 32_000,
} as const;
const DEFAULT_OUTPUT_TOKENS = 1600;
const namePattern = /^[A-Za-z][A-Za-z0-9_-]*$/;
const planIdPattern = /^[a-z][a-z0-9-]*$/;

export type LoadedStage = {
	readonly id: string;
	readonly description: string | null;
	readonly system: string;
	readonly input: readonly { readonly key: string; readonly ref: Ref }[];
	readonly output: JsonSchema;
	readonly outputSchema: z.ZodType;
	readonly runWhen: Condition | null;
	readonly skipWhen: Condition | null;
	readonly maxOutputTokens: number;
};

export type LoadedPlan = {
	readonly id: string;
	readonly version: number;
	readonly description: string;
	/** SHA-256 of the canonical JSON of the document: the plan's content identity. */
	readonly digest: string;
	readonly document: unknown;
	readonly schemas: Readonly<Record<string, JsonSchema>>;
	readonly inputs: Readonly<Record<string, JsonSchema>>;
	readonly inputSchema: z.ZodType<Record<string, unknown>>;
	readonly stages: readonly LoadedStage[];
	readonly outputs: readonly { readonly key: string; readonly ref: Ref }[];
};

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** JSON with object keys in sorted order, so equal documents give equal text. */
export function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isObject(value))
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`;
	return JSON.stringify(value);
}

export const sha256 = (text: string) =>
	createHash("sha256").update(text).digest("hex");

function only(
	raw: Record<string, unknown>,
	allowed: readonly string[],
	where: string,
) {
	for (const key of Object.keys(raw))
		if (!allowed.includes(key))
			throw new PlanError("plan_key_unknown", where ? `${where}.${key}` : key);
}

function record(raw: unknown, where: string): Record<string, unknown> {
	if (raw === undefined) return {};
	if (!isObject(raw)) throw new PlanError("plan_invalid", where);
	for (const key of Object.keys(raw))
		if (!namePattern.test(key))
			throw new PlanError("plan_name_invalid", `${where}.${key}`);
	return raw;
}

/** Parses and checks a plan document (JSON text or the parsed value). Throws `PlanError` on the first fault. */
export function loadPlan(source: string | unknown): LoadedPlan {
	const text = typeof source === "string" ? source : JSON.stringify(source);
	if (text.length > PLAN_LIMITS.documentCharacters)
		throw new PlanError("plan_too_large", "document");
	let raw: unknown;
	try {
		raw = typeof source === "string" ? JSON.parse(source) : source;
	} catch {
		throw new PlanError("plan_json_invalid", "document");
	}
	if (!isObject(raw)) throw new PlanError("plan_invalid", "document");
	only(
		raw,
		["id", "version", "description", "schemas", "inputs", "stages", "outputs"],
		"",
	);
	if (typeof raw.id !== "string" || !planIdPattern.test(raw.id))
		throw new PlanError("plan_id_invalid", "id");
	if (
		typeof raw.version !== "number" ||
		!Number.isInteger(raw.version) ||
		raw.version < 1
	)
		throw new PlanError("plan_version_invalid", "version");
	if (typeof raw.description !== "string" || !raw.description.trim())
		throw new PlanError("plan_description_missing", "description");

	const schemaDocs = record(raw.schemas, "schemas");
	const names = new Set(Object.keys(schemaDocs));
	const schemas = Object.fromEntries(
		Object.entries(schemaDocs).map(([name, value]) => [
			name,
			checkSchema(value, `schemas.${name}`, names),
		]),
	);
	checkRefCycles(schemas);
	const sizes = new Map<string, number>();
	const bounded = (schema: JsonSchema, where: string) => {
		if (expandedSize(schema, schemas, sizes) > EXPANDED_SCHEMA_LIMIT)
			throw new PlanError("schema_too_large", where);
		return schema;
	};

	const inputs = Object.fromEntries(
		Object.entries(record(raw.inputs, "inputs")).map(([name, value]) => [
			name,
			bounded(checkSchema(value, `inputs.${name}`, names), `inputs.${name}`),
		]),
	);
	const inputSchema = z.strictObject(
		Object.fromEntries(
			Object.entries(inputs).map(([name, schema]) => [
				name,
				toZod(schema, schemas),
			]),
		),
	) as unknown as z.ZodType<Record<string, unknown>>;

	if (
		!Array.isArray(raw.stages) ||
		!raw.stages.length ||
		raw.stages.length > PLAN_LIMITS.stages
	)
		throw new PlanError("plan_stages_invalid", "stages");
	const earlier = new Map<string, JsonSchema>();
	const checkRef = (
		ref: Ref,
		where: string,
		upTo: ReadonlyMap<string, JsonSchema>,
	) => {
		const start =
			ref.root === "inputs"
				? Object.hasOwn(inputs, ref.name)
					? inputs[ref.name]
					: undefined
				: upTo.get(ref.name);
		if (!start)
			throw new PlanError(
				ref.root === "inputs" ? "ref_input_unknown" : "ref_stage_not_before",
				where,
			);
		checkRefPath(ref, start, schemas, where);
	};
	const stages = raw.stages.map((item, index): LoadedStage => {
		const where = `stages[${index}]`;
		if (!isObject(item)) throw new PlanError("plan_invalid", where);
		only(
			item,
			[
				"id",
				"description",
				"system",
				"input",
				"output",
				"runWhen",
				"skipWhen",
				"maxOutputTokens",
			],
			where,
		);
		if (typeof item.id !== "string" || !namePattern.test(item.id))
			throw new PlanError("stage_id_invalid", `${where}.id`);
		if (earlier.has(item.id))
			throw new PlanError("stage_id_duplicate", `${where}.id`);
		if (item.description !== undefined && typeof item.description !== "string")
			throw new PlanError("plan_invalid", `${where}.description`);
		if (
			typeof item.system !== "string" ||
			!item.system.trim() ||
			item.system.length > PLAN_LIMITS.systemCharacters
		)
			throw new PlanError("stage_system_invalid", `${where}.system`);
		const input = Object.entries(record(item.input, `${where}.input`)).map(
			([key, text]) => {
				const ref = parseRef(text, `${where}.input.${key}`);
				checkRef(ref, `${where}.input.${key}`, earlier);
				return { key, ref };
			},
		);
		const output = bounded(
			checkSchema(item.output, `${where}.output`, names),
			`${where}.output`,
		);
		if (resolveRef(output, schemas).type !== "object")
			throw new PlanError("output_schema_not_object", `${where}.output`);
		checkStrict(output, `${where}.output`, schemas);
		const condition = (key: "runWhen" | "skipWhen") => {
			if (item[key] === undefined) return null;
			const refs: Ref[] = [];
			const parsed = parseCondition(item[key], `${where}.${key}`, refs);
			for (const ref of refs) checkRef(ref, `${where}.${key}`, earlier);
			return parsed;
		};
		const tokens = item.maxOutputTokens ?? DEFAULT_OUTPUT_TOKENS;
		if (
			typeof tokens !== "number" ||
			!Number.isInteger(tokens) ||
			tokens < 1 ||
			tokens > PLAN_LIMITS.maxOutputTokens
		)
			throw new PlanError("stage_tokens_invalid", `${where}.maxOutputTokens`);
		const stage: LoadedStage = {
			id: item.id,
			description: item.description ?? null,
			system: item.system,
			input,
			output,
			outputSchema: toZod(output, schemas),
			runWhen: condition("runWhen"),
			skipWhen: condition("skipWhen"),
			maxOutputTokens: tokens,
		};
		earlier.set(stage.id, output);
		return stage;
	});

	const outputs = Object.entries(record(raw.outputs, "outputs")).map(
		([key, text]) => {
			const ref = parseRef(text, `outputs.${key}`);
			checkRef(ref, `outputs.${key}`, earlier);
			return { key, ref };
		},
	);
	if (!outputs.length) throw new PlanError("plan_outputs_missing", "outputs");

	return {
		id: raw.id,
		version: raw.version,
		description: raw.description,
		digest: sha256(canonicalJson(raw)),
		document: raw,
		schemas,
		inputs,
		inputSchema,
		stages,
		outputs,
	};
}
