import { PlanError } from "./errors";
import { resolveRef, type JsonSchema } from "./schema";

/**
 * A parsed reference: the plan input, earlier stage or (in an `ensure` rule) the stage's own output it starts
 * at, then object keys, array indexes and, where allowed, `*` for every element of an array.
 */
export type Ref = {
	readonly root: "inputs" | "round" | "stage" | "output";
	/** The input, round input or stage name; empty for `output`. */
	readonly name: string;
	readonly path: readonly Key[];
};
/** An object key, an array index, or `"*"` (every element; names never match `*`). */
type Key = string | number;
const EVERY = "*";

export type RefOptions = {
	/** `$.output…` is allowed (inside an `ensure` rule). */
	readonly output?: boolean;
	/** `[*]` is allowed (in the operands of `each … in …`). */
	readonly every?: boolean;
};

const name = "[A-Za-z][A-Za-z0-9_-]*";
const head = new RegExp(
	`^\\$\\.(?:(inputs|round|stages)\\.(${name})|(output))`,
);
const segment = new RegExp(`^(?:\\.(${name})|\\[(\\d+|\\*)\\])`);

/** `$.inputs.<name>…`, `$.round.<name>…`, `$.stages.<id>.output…` or `$.output…`, then `.key`, `[index]`, `[*]`. */
export function parseRef(
	text: unknown,
	where: string,
	options: RefOptions = {},
): Ref {
	if (typeof text !== "string") throw new PlanError("ref_invalid", where);
	const start = head.exec(text);
	if (!start) throw new PlanError("ref_invalid", where);
	let rest = text.slice(start[0].length);
	const root = start[3]
		? "output"
		: start[1] === "inputs"
			? "inputs"
			: start[1] === "round"
				? "round"
				: "stage";
	if (root === "output" && !options.output)
		throw new PlanError("ref_invalid", where);
	if (root === "stage") {
		if (!rest.startsWith(".output")) throw new PlanError("ref_invalid", where);
		rest = rest.slice(".output".length);
	}
	const path: Key[] = [];
	while (rest) {
		const match = segment.exec(rest);
		if (!match) throw new PlanError("ref_invalid", where);
		if (match[2] === EVERY && !options.every)
			throw new PlanError("ref_invalid", where);
		path.push(match[1] ?? (match[2] === EVERY ? EVERY : Number(match[2])));
		rest = rest.slice(match[0].length);
	}
	return { root, name: start[2] ?? "", path };
}

/** What a reference reads from: the plan's inputs, the stages that ran, and the output being checked. */
export type Scope = {
	readonly inputs: Readonly<Record<string, unknown>>;
	/** This round's input; absent in the first round, where `$.round…` reads null. */
	readonly round?: Readonly<Record<string, unknown>>;
	readonly stages: ReadonlyMap<string, { readonly output: unknown }>;
	readonly output?: unknown;
};

function rootValue(ref: Ref, scope: Scope): unknown {
	if (ref.root === "output") return scope.output ?? null;
	if (ref.root === "stage") return scope.stages.get(ref.name)?.output ?? null;
	if (ref.root === "round")
		return scope.round && Object.hasOwn(scope.round, ref.name)
			? scope.round[ref.name]
			: null;
	return Object.hasOwn(scope.inputs, ref.name)
		? scope.inputs[ref.name]
		: undefined;
}

function step(value: unknown, key: Key): unknown {
	if (value === null || value === undefined) return undefined;
	if (typeof key === "number")
		return Array.isArray(value) ? value[key] : undefined;
	return typeof value === "object" &&
		!Array.isArray(value) &&
		Object.hasOwn(value, key)
		? (value as Record<string, unknown>)[key]
		: undefined;
}

/** The referenced value; anything missing on the way (a skipped stage, an absent key) reads as null. */
export function readRef(ref: Ref, scope: Scope): unknown {
	let value = rootValue(ref, scope);
	for (const key of ref.path) value = step(value, key);
	return value === undefined ? null : value;
}

/** Every value the reference reaches, `[*]` expanded; missing values are left out. */
export function readEvery(ref: Ref, scope: Scope): unknown[] {
	let values = [rootValue(ref, scope)];
	for (const key of ref.path)
		values =
			key === EVERY
				? values.flatMap((value) => (Array.isArray(value) ? value : []))
				: values.map((value) => step(value, key));
	return values.filter((value) => value !== null && value !== undefined);
}

/**
 * Follows the path through the schema it starts at, so a typo in a key is a load error, and returns the
 * schema the path ends at. Only closed objects (`additionalProperties: false`) are checked; past an open
 * object or an `anyOf` the schema is unknown and `undefined` is returned.
 */
export function checkRefPath(
	ref: Ref,
	start: JsonSchema,
	defs: Readonly<Record<string, JsonSchema>>,
	where: string,
): JsonSchema | undefined {
	let schema: JsonSchema | undefined = resolveRef(start, defs);
	for (const key of ref.path) {
		if (!schema || schema.anyOf) return undefined;
		if (typeof key === "number" || key === EVERY) {
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
			return undefined;
		}
		schema = resolveRef(next, defs);
	}
	return schema;
}
