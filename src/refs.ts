import { PlanError } from "./errors";
import { resolveRef, type JsonSchema } from "./schema";

/** A parsed reference: the plan input or stage it starts at, then object keys and array indexes. */
export type Ref =
	| {
			readonly root: "inputs";
			readonly name: string;
			readonly path: readonly Key[];
	  }
	| {
			readonly root: "stage";
			readonly name: string;
			readonly path: readonly Key[];
	  };
type Key = string | number;

const name = "[A-Za-z][A-Za-z0-9_-]*";
const head = new RegExp(`^\\$\\.(inputs|stages)\\.(${name})`);
const segment = new RegExp(`^(?:\\.(${name})|\\[(\\d+)\\])`);

/** `$.inputs.<name>…` or `$.stages.<id>.output…`, followed by `.key` and `[index]` segments. */
export function parseRef(text: unknown, where: string): Ref {
	if (typeof text !== "string") throw new PlanError("ref_invalid", where);
	const start = head.exec(text);
	if (!start) throw new PlanError("ref_invalid", where);
	let rest = text.slice(start[0].length);
	const root = start[1] === "inputs" ? "inputs" : "stage";
	if (root === "stage") {
		if (!rest.startsWith(".output")) throw new PlanError("ref_invalid", where);
		rest = rest.slice(".output".length);
	}
	const path: Key[] = [];
	while (rest) {
		const match = segment.exec(rest);
		if (!match) throw new PlanError("ref_invalid", where);
		path.push(match[1] ?? Number(match[2]));
		rest = rest.slice(match[0].length);
	}
	return { root, name: start[2]!, path };
}

/** What a reference reads from: the plan's inputs and the stages that ran (a skipped stage has no output). */
export type Scope = {
	readonly inputs: Readonly<Record<string, unknown>>;
	readonly stages: ReadonlyMap<string, { readonly output: unknown }>;
};

/** The referenced value; anything missing on the way (a skipped stage, an absent key) reads as null. */
export function readRef(ref: Ref, scope: Scope): unknown {
	let value: unknown =
		ref.root === "inputs"
			? Object.hasOwn(scope.inputs, ref.name)
				? scope.inputs[ref.name]
				: undefined
			: (scope.stages.get(ref.name)?.output ?? null);
	for (const key of ref.path) {
		if (value === null || value === undefined) return null;
		value =
			typeof key === "number"
				? Array.isArray(value)
					? value[key]
					: undefined
				: typeof value === "object" &&
					  !Array.isArray(value) &&
					  Object.hasOwn(value, key)
					? (value as Record<string, unknown>)[key]
					: undefined;
	}
	return value === undefined ? null : value;
}

/**
 * Follows the path through the schema it starts at, so a typo in a key is a load error. Only closed objects
 * (`additionalProperties: false`) are checked; a key inside an open object or an `anyOf` is accepted.
 */
export function checkRefPath(
	ref: Ref,
	start: JsonSchema,
	defs: Readonly<Record<string, JsonSchema>>,
	where: string,
): void {
	let schema: JsonSchema | undefined = resolveRef(start, defs);
	for (const key of ref.path) {
		if (!schema || schema.anyOf) return;
		if (typeof key === "number") {
			if (schema.type !== "array")
				throw new PlanError("ref_path_unknown", where);
			schema = schema.items && resolveRef(schema.items, defs);
			continue;
		}
		if (schema.type !== "object")
			throw new PlanError("ref_path_unknown", where);
		const next: JsonSchema | undefined =
			schema.properties && Object.hasOwn(schema.properties, key)
				? schema.properties[key]
				: undefined;
		if (!next) {
			if (schema.additionalProperties === false)
				throw new PlanError("ref_path_unknown", where);
			return;
		}
		schema = resolveRef(next, defs);
	}
}
