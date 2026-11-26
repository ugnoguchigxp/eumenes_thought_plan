import type { RunResult } from "../src/run";

/** One check of a scenario's run: what was expected and what the run gave. */
export type Check = {
	readonly name: string;
	readonly ok: boolean;
	readonly detail: string;
};

/**
 * A situation to think through with one plan. `fixture` holds an answer for each stage the model is asked
 * for, so the scenario also runs without a model (and in `bun test`); a live run asks the configured model.
 */
export type Scenario = {
	readonly id: string;
	readonly description: string;
	/** A bundled plan id, or a file in `examples/plans/`. */
	readonly plan: { readonly bundled: string } | { readonly file: string };
	readonly inputs: Record<string, unknown>;
	/** Stages that must run and stages that must be skipped. */
	readonly ran: readonly string[];
	readonly skipped: readonly string[];
	readonly fixture: Record<string, unknown>;
	readonly checks: (result: RunResult) => readonly Check[];
};

/** Reads a value of the run's outputs by dotted path (`plan.candidates.0.steps`). */
export function outputAt(result: RunResult, path: string): unknown {
	let value: unknown = result.outputs;
	for (const key of path.split(".")) {
		if (value === null || typeof value !== "object") return undefined;
		value = (value as Record<string, unknown>)[key];
	}
	return value;
}

export const check = (name: string, ok: boolean, detail: unknown): Check => ({
	name,
	ok,
	detail: typeof detail === "string" ? detail : JSON.stringify(detail),
});
