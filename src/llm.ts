import type { z } from "zod";

/** What the model call drew its inputs from; passed through to the host untouched. */
export interface InputContext {
	readonly sources: readonly string[];
	readonly complete: boolean;
}

/**
 * One structured model call, continuing `session` when given. The same shape as `eumenes-agency`'s `LlmPort`, so the Eumenes host's
 * model connection plugs in as it is. The runner revalidates the returned value against the stage's schema.
 */
/** One earlier exchange of the session: the stage's system context and input, and what the model answered. */
export interface SessionTurn {
	readonly system: string;
	readonly prompt: string;
	/** The answer as JSON text. */
	readonly output: string;
}

/**
 * The model session a call continues. Every stage of a run shares one unless it is `independent`; `turns` are
 * its earlier exchanges in order, which the port gives the model before this call. `cache: false` asks the
 * port not to reuse a cached prefix for the session.
 */
export interface LlmSession {
	readonly id: string;
	readonly turns: readonly SessionTurn[];
	readonly cache: boolean;
}

export interface LlmRequest<T> {
	readonly input?: InputContext;
	readonly session?: LlmSession;
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
