import { PlanError } from "./errors";
import { parseRef, readRef, type Ref, type Scope } from "./refs";

/** A condition decided without the model. */
export type Condition =
	| { readonly path: Ref; readonly equals: unknown }
	| { readonly path: Ref; readonly in: readonly unknown[] }
	| { readonly path: Ref; readonly exists: boolean }
	| { readonly all: readonly Condition[] }
	| { readonly any: readonly Condition[] }
	| { readonly not: Condition };

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Parses a condition of the plan document; every reference it holds is collected in `refs`. */
export function parseCondition(
	raw: unknown,
	where: string,
	refs: Ref[],
	depth = 0,
): Condition {
	if (!isObject(raw) || depth > 8)
		throw new PlanError("condition_invalid", where);
	const keys = Object.keys(raw).sort().join(",");
	switch (keys) {
		case "equals,path":
		case "in,path":
		case "exists,path": {
			const path = parseRef(raw.path, `${where}.path`);
			refs.push(path);
			if ("in" in raw) {
				if (!Array.isArray(raw.in) || !raw.in.length)
					throw new PlanError("condition_invalid", `${where}.in`);
				return { path, in: raw.in };
			}
			if ("exists" in raw) {
				if (typeof raw.exists !== "boolean")
					throw new PlanError("condition_invalid", `${where}.exists`);
				return { path, exists: raw.exists };
			}
			return { path, equals: raw.equals };
		}
		case "all":
		case "any": {
			const list = raw[keys];
			if (!Array.isArray(list) || !list.length)
				throw new PlanError("condition_invalid", `${where}.${keys}`);
			const items = list.map((item, i) =>
				parseCondition(item, `${where}.${keys}[${i}]`, refs, depth + 1),
			);
			return keys === "all" ? { all: items } : { any: items };
		}
		case "not":
			return {
				not: parseCondition(raw.not, `${where}.not`, refs, depth + 1),
			};
		default:
			throw new PlanError("condition_invalid", where);
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
