import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PlanError } from "./errors";
import { loadPlan, type LoadedPlan } from "./plan";

/** Every `*.json` in the directory as a plan; two documents with the same id and version are refused. */
export function loadPlanDirectory(dir: string): LoadedPlan[] {
	const plans = readdirSync(dir)
		.filter((name) => name.endsWith(".json"))
		.sort()
		.map((name) => {
			try {
				return loadPlan(readFileSync(join(dir, name), "utf8"));
			} catch (error) {
				if (error instanceof PlanError)
					throw new PlanError(error.code, `${name}: ${error.where}`);
				throw error;
			}
		});
	return mergePlans(plans);
}

/**
 * One list of plans from several sources. The same id and version twice is kept once when the bodies are
 * equal, and refused when they differ, so every lookup of `id@version` sees the same plan.
 */
export function mergePlans(
	...lists: readonly (readonly LoadedPlan[])[]
): LoadedPlan[] {
	const byKey = new Map<string, LoadedPlan>();
	for (const plan of lists.flat()) {
		const key = `${plan.id}@${plan.version}`;
		const seen = byKey.get(key);
		if (seen && seen.digest !== plan.digest)
			throw new PlanError("plan_duplicate", key);
		byKey.set(key, plan);
	}
	return [...byKey.values()];
}

/**
 * Every `*.json` in the directory, keeping the ones that load and naming the ones that do not, so one broken
 * file of a user's directory does not stop a server that serves the rest.
 */
export function scanPlanDirectory(dir: string): {
	plans: LoadedPlan[];
	invalid: { file: string; code: string; where: string }[];
} {
	const plans: LoadedPlan[] = [];
	const invalid: { file: string; code: string; where: string }[] = [];
	for (const name of readdirSync(dir)
		.filter((file) => file.endsWith(".json"))
		.sort())
		try {
			plans.push(loadPlan(readFileSync(join(dir, name), "utf8")));
		} catch (error) {
			invalid.push({
				file: join(dir, name),
				code: error instanceof PlanError ? error.code : "plan_unreadable",
				where: error instanceof PlanError ? error.where : "document",
			});
		}
	return { plans, invalid };
}

/** The thought patterns shipped with the package (`plans/`). */
export const bundledPlans = (): LoadedPlan[] =>
	loadPlanDirectory(join(import.meta.dir, "..", "plans"));
