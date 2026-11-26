import type { z } from "zod";

/** What the model call drew its inputs from; passed through to the host untouched. */
export interface InputContext {
	readonly sources: readonly string[];
	readonly complete: boolean;
}

/**
 * One stateless structured model call. The same shape as `eumenes-agency`'s `LlmPort`, so the Eumenes host's
 * model connection plugs in as it is. The runner revalidates the returned value against the stage's schema.
 */
export interface LlmRequest<T> {
	readonly input?: InputContext;
	readonly purpose: "think";
	readonly system: string;
	/** The stage's input object as JSON. */
	readonly prompt: string;
	readonly schema: z.ZodType<T>;
	readonly maxOutputTokens: number;
}

export interface LlmResult<T> {
	readonly value: T;
	readonly model: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly latencyMs: number;
}

export interface LlmPort {
	complete<T>(
		request: LlmRequest<T>,
		signal: AbortSignal,
	): Promise<LlmResult<T>>;
}
