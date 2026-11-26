import type { LlmPort, LlmRequest } from "../src/llm";

/** A model that answers each call from `answer`, and keeps every request it received. */
export function fakeLlm(answer: (request: LlmRequest<unknown>) => unknown) {
	const calls: LlmRequest<unknown>[] = [];
	const llm: LlmPort = {
		async complete<T>(request: LlmRequest<T>, signal: AbortSignal) {
			signal.throwIfAborted();
			calls.push(request as LlmRequest<unknown>);
			return {
				value: answer(request as LlmRequest<unknown>) as T,
				model: "fixture",
				inputTokens: 10,
				outputTokens: 5,
				cacheReadTokens: 0,
				latencyMs: 1,
			};
		},
	};
	return { llm, calls };
}

/** A small two-stage plan used across the tests. */
export const twoStagePlan = {
	id: "two-stage",
	version: 1,
	description: "判断してから計画する",
	inputs: {
		question: { type: "string" },
		known: { type: "boolean" },
	},
	stages: [
		{
			id: "judge",
			system: "判断する。",
			input: { question: "$.inputs.question" },
			output: {
				type: "object",
				properties: {
					decision: { enum: ["go", "stop"] },
					reason: { type: "string" },
				},
				required: ["decision", "reason"],
				additionalProperties: false,
			},
			skipWhen: { path: "$.inputs.known", equals: true },
		},
		{
			id: "plan",
			system: "計画する。",
			input: {
				question: "$.inputs.question",
				judgment: "$.stages.judge.output",
			},
			output: {
				type: "object",
				properties: {
					steps: { type: "array", items: { type: "string" }, maxItems: 3 },
				},
				required: ["steps"],
				additionalProperties: false,
			},
			runWhen: { path: "$.stages.judge.output.decision", equals: "go" },
		},
	],
	outputs: {
		decision: "$.stages.judge.output.decision",
		steps: "$.stages.plan.output.steps",
	},
};
