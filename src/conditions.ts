import { PlanError } from "./errors";
import {
	parseRef,
	readEvery,
	readRef,
	type Ref,
	type RefOptions,
	type Scope,
} from "./refs";

/** A condition decided without the model. */
export type Condition =
	| { readonly path: Ref; readonly equals: unknown }
	| { readonly path: Ref; readonly in: readonly unknown[] }
	| { readonly path: Ref; readonly exists: boolean }
	| { readonly all: readonly Condition[] }
	| { readonly any: readonly Condition[] }
	| { readonly not: Condition };

/** A reference a condition or rule reads, with the values it compares it to (none for `exists`). */
export type ConditionLeaf = {
	readonly ref: Ref;
	readonly where: string;
	readonly values: readonly unknown[];
};

/**
 * A rule a stage's output must keep, decided without the model after the output passed its schema:
 * `when`/`require` (if one holds, so does the other; not `then`, so a rule is never thenable), `each`/`in` (every value on the left is among the values on
 * the right), `index`/`within` (an integer that is a valid index of an array, or null).
 */
export type EnsureRule =
	| { readonly when: Condition; readonly require: Condition }
	| { readonly each: Ref; readonly in: Ref }
	| { readonly index: Ref; readonly within: Ref };

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Parses a condition of the plan document; every reference it holds is collected in `leaves`. */
export function parseCondition(
	raw: unknown,
	where: string,
	leaves: ConditionLeaf[],
	options: RefOptions = {},
	depth = 0,
): Condition {
	if (!isObject(raw) || depth > 8)
		throw new PlanError("condition_invalid", where);
	const keys = Object.keys(raw).sort().join(",");
	switch (keys) {
		case "equals,path":
		case "in,path":
		case "exists,path": {
			const path = parseRef(raw.path, `${where}.path`, {
				output: options.output ?? false,
			});
			if ("in" in raw) {
				if (!Array.isArray(raw.in) || !raw.in.length)
					throw new PlanError("condition_invalid", `${where}.in`);
				leaves.push({ ref: path, where, values: raw.in });
				return { path, in: raw.in };
			}
			if ("exists" in raw) {
				if (typeof raw.exists !== "boolean")
					throw new PlanError("condition_invalid", `${where}.exists`);
				leaves.push({ ref: path, where, values: [] });
				return { path, exists: raw.exists };
			}
			leaves.push({ ref: path, where, values: [raw.equals] });
			return { path, equals: raw.equals };
		}
		case "all":
		case "any": {
			const list = raw[keys];
			if (!Array.isArray(list) || !list.length)
				throw new PlanError("condition_invalid", `${where}.${keys}`);
			const items = list.map((item, i) =>
				parseCondition(
					item,
					`${where}.${keys}[${i}]`,
					leaves,
					options,
					depth + 1,
				),
			);
			return keys === "all" ? { all: items } : { any: items };
		}
		case "not":
			return {
				not: parseCondition(
					raw.not,
					`${where}.not`,
					leaves,
					options,
					depth + 1,
				),
			};
		default:
			throw new PlanError("condition_invalid", where);
	}
}

/** Parses one `ensure` rule; its references are collected for the plan's load checks. */
export function parseEnsureRule(
	raw: unknown,
	where: string,
	leaves: ConditionLeaf[],
): EnsureRule {
	if (!isObject(raw)) throw new PlanError("ensure_invalid", where);
	const keys = Object.keys(raw).sort().join(",");
	const ref = (key: string, every: boolean) => {
		const parsed = parseRef(raw[key], `${where}.${key}`, {
			output: true,
			every,
		});
		leaves.push({ ref: parsed, where: `${where}.${key}`, values: [] });
		return parsed;
	};
	switch (keys) {
		case "require,when":
			return {
				when: parseCondition(raw.when, `${where}.when`, leaves, {
					output: true,
				}),
				require: parseCondition(raw.require, `${where}.require`, leaves, {
					output: true,
				}),
			};
		case "each,in":
			return { each: ref("each", true), in: ref("in", true) };
		case "index,within":
			return { index: ref("index", false), within: ref("within", false) };
		default:
			throw new PlanError("ensure_invalid", where);
	}
}

/** JSON values compare by content: two equal objects match regardless of key order. */
function same(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (Array.isArray(a) && Array.isArray(b))
		return a.length === b.length && a.every((item, i) => same(item, b[i]));
	if (isObject(a) && isObject(b)) {
		const keys = Object.keys(a);
		return (
			keys.length === Object.keys(b).length &&
			keys.every((key) => key in b && same(a[key], b[key]))
		);
	}
	return false;
}

export function holds(condition: Condition, scope: Scope): boolean {
	if ("all" in condition) return condition.all.every((c) => holds(c, scope));
	if ("any" in condition) return condition.any.some((c) => holds(c, scope));
	if ("not" in condition) return !holds(condition.not, scope);
	const value = readRef(condition.path, scope);
	if ("exists" in condition) return (value !== null) === condition.exists;
	if ("in" in condition) return condition.in.some((item) => same(value, item));
	return same(value, condition.equals);
}

/** Whether an output keeps the rule (the scope carries the output as `$.output`). */
export function keeps(rule: EnsureRule, scope: Scope): boolean {
	if ("when" in rule)
		return !holds(rule.when, scope) || holds(rule.require, scope);
	if ("each" in rule) {
		const allowed = readEvery(rule.in, scope);
		return readEvery(rule.each, scope).every((value) =>
			allowed.some((item) => same(value, item)),
		);
	}
	const index = readRef(rule.index, scope);
	const list = readRef(rule.within, scope);
	// A null index (an optional choice left empty) asks for no element; `when`/`require` can demand one.
	if (index === null) return true;
	return (
		typeof index === "number" &&
		Number.isInteger(index) &&
		Array.isArray(list) &&
		index >= 0 &&
		index < list.length
	);
}
