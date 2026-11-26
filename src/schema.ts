import { z } from "zod";
import { PlanError } from "./errors";

/** The JSON Schema subset a plan may use: what structured model output accepts, nothing more. */
export type JsonSchema = {
	readonly type?: JsonType;
	readonly description?: string;
	readonly properties?: Readonly<Record<string, JsonSchema>>;
	readonly required?: readonly string[];
	readonly additionalProperties?: false;
	readonly items?: JsonSchema;
	readonly enum?: readonly Primitive[];
	readonly const?: Primitive;
	readonly anyOf?: readonly JsonSchema[];
	readonly minItems?: number;
	readonly maxItems?: number;
	readonly minLength?: number;
	readonly maxLength?: number;
	readonly minimum?: number;
	readonly maximum?: number;
	readonly $ref?: string;
};
type JsonType =
	"object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
type Primitive = string | number | boolean | null;

const types = new Set<string>([
	"object",
	"array",
	"string",
	"number",
	"integer",
	"boolean",
	"null",
]);
const keywords = new Set<string>([
	"type",
	"description",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"enum",
	"const",
	"anyOf",
	"minItems",
	"maxItems",
	"minLength",
	"maxLength",
	"minimum",
	"maximum",
	"$ref",
]);
const refPattern = /^#\/schemas\/([A-Za-z][A-Za-z0-9_-]*)$/;

const isPrimitive = (value: unknown): value is Primitive =>
	value === null || ["string", "number", "boolean"].includes(typeof value);
const isCount = (value: unknown) =>
	typeof value === "number" && Number.isInteger(value) && value >= 0;
const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Checks a schema against the subset; `where` names its place in the plan for the error. */
export function checkSchema(
	raw: unknown,
	where: string,
	names: ReadonlySet<string>,
): JsonSchema {
	if (!isObject(raw)) throw new PlanError("schema_invalid", where);
	for (const key of Object.keys(raw))
		if (!keywords.has(key))
			throw new PlanError("schema_keyword_unsupported", `${where}.${key}`);
	const schema = raw as JsonSchema;
	if (schema.$ref !== undefined) {
		const name = refPattern.exec(schema.$ref)?.[1];
		if (!name || !names.has(name))
			throw new PlanError("schema_ref_unknown", where);
		if (Object.keys(raw).some((key) => key !== "$ref" && key !== "description"))
			throw new PlanError("schema_ref_mixed", where);
		return schema;
	}
	if (schema.type !== undefined && !types.has(schema.type))
		throw new PlanError("schema_type_unsupported", where);
	if (
		schema.description !== undefined &&
		typeof schema.description !== "string"
	)
		throw new PlanError("schema_invalid", `${where}.description`);
	for (const key of ["minItems", "maxItems", "minLength", "maxLength"] as const)
		if (schema[key] !== undefined && !isCount(schema[key]))
			throw new PlanError("schema_invalid", `${where}.${key}`);
	for (const key of ["minimum", "maximum"] as const)
		if (schema[key] !== undefined && typeof schema[key] !== "number")
			throw new PlanError("schema_invalid", `${where}.${key}`);
	if (
		schema.enum !== undefined &&
		(!Array.isArray(schema.enum) ||
			!schema.enum.length ||
			!schema.enum.every(isPrimitive))
	)
		throw new PlanError("schema_invalid", `${where}.enum`);
	if (schema.const !== undefined && !isPrimitive(schema.const))
		throw new PlanError("schema_invalid", `${where}.const`);
	if (schema.anyOf !== undefined) {
		if (!Array.isArray(schema.anyOf) || schema.anyOf.length < 2)
			throw new PlanError("schema_invalid", `${where}.anyOf`);
		schema.anyOf.forEach((item, i) =>
			checkSchema(item, `${where}.anyOf[${i}]`, names),
		);
	}
	if (
		schema.type === undefined &&
		schema.anyOf === undefined &&
		schema.enum === undefined &&
		schema.const === undefined
	)
		throw new PlanError("schema_type_missing", where);
	if (schema.properties !== undefined) {
		if (schema.type !== "object" || !isObject(schema.properties))
			throw new PlanError("schema_invalid", `${where}.properties`);
		for (const [key, value] of Object.entries(schema.properties))
			checkSchema(value, `${where}.properties.${key}`, names);
	}
	if (schema.required !== undefined) {
		const properties = schema.properties ?? {};
		if (
			!Array.isArray(schema.required) ||
			!schema.required.every(
				(key) => typeof key === "string" && Object.hasOwn(properties, key),
			)
		)
			throw new PlanError("schema_invalid", `${where}.required`);
	}
	if (
		schema.additionalProperties !== undefined &&
		(schema.additionalProperties !== false || schema.type !== "object")
	)
		throw new PlanError("schema_invalid", `${where}.additionalProperties`);
	if (schema.items !== undefined) {
		if (schema.type !== "array")
			throw new PlanError("schema_invalid", `${where}.items`);
		checkSchema(schema.items, `${where}.items`, names);
	}
	if (schema.type === "array" && schema.items === undefined)
		throw new PlanError("schema_items_missing", where);
	return schema;
}

/**
 * A stage's output goes to the model as strict structured output: every object closes its properties and
 * requires all of them (a value that may be absent is written as `anyOf` with `null`).
 */
export function checkStrict(
	schema: JsonSchema,
	where: string,
	defs: Readonly<Record<string, JsonSchema>>,
	checked: Set<string> = new Set(),
): void {
	if (schema.$ref) {
		// Cycles are rejected before this runs; a definition is checked once however often it is used.
		const name = refPattern.exec(schema.$ref)![1]!;
		if (checked.has(name)) return;
		checked.add(name);
		checkStrict(defs[name]!, where, defs, checked);
		return;
	}
	if (schema.type === "object") {
		const keys = Object.keys(schema.properties ?? {});
		if (
			schema.additionalProperties !== false ||
			keys.some((key) => !schema.required?.includes(key))
		)
			throw new PlanError("output_schema_not_strict", where);
		for (const key of keys)
			checkStrict(
				schema.properties![key]!,
				`${where}.properties.${key}`,
				defs,
				checked,
			);
	}
	if (schema.items) checkStrict(schema.items, `${where}.items`, defs, checked);
	schema.anyOf?.forEach((item, i) =>
		checkStrict(item, `${where}.anyOf[${i}]`, defs, checked),
	);
}

/** The schema a `$ref` chain ends at (cycles are rejected before this runs). */
export function resolveRef(
	schema: JsonSchema,
	defs: Readonly<Record<string, JsonSchema>>,
): JsonSchema {
	let current = schema;
	const seen = new Set<string>();
	while (current.$ref) {
		const name = refPattern.exec(current.$ref)![1]!;
		if (seen.has(name))
			throw new PlanError("schema_ref_cycle", `schemas.${name}`);
		seen.add(name);
		current = defs[name]!;
	}
	return current;
}

/** The definitions a schema names directly (through its own properties, items and alternatives). */
function namedRefs(schema: JsonSchema): string[] {
	if (schema.$ref) return [refPattern.exec(schema.$ref)![1]!];
	return [
		...Object.values(schema.properties ?? {}).flatMap(namedRefs),
		...(schema.items ? namedRefs(schema.items) : []),
		...(schema.anyOf ?? []).flatMap(namedRefs),
	];
}

/** Rejects a `$ref` chain that returns to a schema it started from; each definition is visited once. */
export function checkRefCycles(
	defs: Readonly<Record<string, JsonSchema>>,
): void {
	const state = new Map<string, "open" | "done">();
	const visit = (name: string): void => {
		const seen = state.get(name);
		if (seen === "done") return;
		if (seen === "open")
			throw new PlanError("schema_ref_cycle", `schemas.${name}`);
		state.set(name, "open");
		for (const next of namedRefs(defs[name]!)) visit(next);
		state.set(name, "done");
	};
	for (const name of Object.keys(defs)) visit(name);
}

/** Schema nodes a schema spans once every `$ref` is expanded; refused above this. */
export const EXPANDED_SCHEMA_LIMIT = 4000;

/**
 * The node count of the schema with its references expanded, counted with each definition's size memoized,
 * so a plan whose definitions fan out (and would expand to an enormous schema) is refused at load.
 */
export function expandedSize(
	schema: JsonSchema,
	defs: Readonly<Record<string, JsonSchema>>,
	memo: Map<string, number> = new Map(),
): number {
	if (schema.$ref) {
		const name = refPattern.exec(schema.$ref)![1]!;
		const known = memo.get(name);
		if (known !== undefined) return known;
		const size = expandedSize(defs[name]!, defs, memo);
		memo.set(name, size);
		return size;
	}
	let size = 1;
	for (const value of Object.values(schema.properties ?? {}))
		size += expandedSize(value, defs, memo);
	if (schema.items) size += expandedSize(schema.items, defs, memo);
	for (const item of schema.anyOf ?? []) size += expandedSize(item, defs, memo);
	return Math.min(size, Number.MAX_SAFE_INTEGER);
}

/** The schema with every `$ref` replaced by what it names: what a caller outside the plan can read alone. */
export function inlineRefs(
	schema: JsonSchema,
	defs: Readonly<Record<string, JsonSchema>>,
): JsonSchema {
	if (schema.$ref) {
		const target = inlineRefs(resolveRef(schema, defs), defs);
		return schema.description
			? { ...target, description: schema.description }
			: target;
	}
	return {
		...schema,
		...(schema.properties && {
			properties: Object.fromEntries(
				Object.entries(schema.properties).map(([key, value]) => [
					key,
					inlineRefs(value, defs),
				]),
			),
		}),
		...(schema.items && { items: inlineRefs(schema.items, defs) }),
		...(schema.anyOf && {
			anyOf: schema.anyOf.map((item) => inlineRefs(item, defs)),
		}),
	};
}

/** The zod schema that validates the same values as `schema`. */
export function toZod(
	schema: JsonSchema,
	defs: Readonly<Record<string, JsonSchema>>,
): z.ZodType {
	const described = (type: z.ZodType) =>
		schema.description ? type.describe(schema.description) : type;
	if (schema.$ref) return described(toZod(resolveRef(schema, defs), defs));
	if (schema.const !== undefined) return described(z.literal(schema.const));
	if (schema.enum?.every((value) => typeof value === "string")) {
		const [first, ...rest] = schema.enum;
		return described(z.enum([first!, ...rest]));
	}
	if (schema.enum) {
		const [first, second, ...rest] = schema.enum.map((value) =>
			z.literal(value),
		);
		return described(second ? z.union([first!, second, ...rest]) : first!);
	}
	if (schema.anyOf) {
		const [first, second, ...rest] = schema.anyOf.map((item) =>
			toZod(item, defs),
		);
		return described(z.union([first!, second!, ...rest]));
	}
	switch (schema.type) {
		case "string": {
			let type = z.string();
			if (schema.minLength !== undefined) type = type.min(schema.minLength);
			if (schema.maxLength !== undefined) type = type.max(schema.maxLength);
			return described(type);
		}
		case "number":
		case "integer": {
			let type = schema.type === "integer" ? z.number().int() : z.number();
			if (schema.minimum !== undefined) type = type.min(schema.minimum);
			if (schema.maximum !== undefined) type = type.max(schema.maximum);
			return described(type);
		}
		case "boolean":
			return described(z.boolean());
		case "null":
			return described(z.null());
		case "array": {
			let type = z.array(toZod(schema.items!, defs));
			if (schema.minItems !== undefined) type = type.min(schema.minItems);
			if (schema.maxItems !== undefined) type = type.max(schema.maxItems);
			return described(type);
		}
		case "object": {
			const required = new Set(schema.required ?? []);
			const shape = Object.fromEntries(
				Object.entries(schema.properties ?? {}).map(([key, value]) => {
					const type = toZod(value, defs);
					return [key, required.has(key) ? type : type.optional()];
				}),
			);
			return described(
				schema.additionalProperties === false
					? z.strictObject(shape)
					: z.looseObject(shape),
			);
		}
		default:
			throw new PlanError("schema_type_missing", "schema");
	}
}
