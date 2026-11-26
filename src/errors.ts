/** A plan that cannot be loaded: `code` is a fixed identifier, `where` the place in the plan document. */
export class PlanError extends Error {
	constructor(
		readonly code: string,
		readonly where: string,
	) {
		super(`${code}: ${where}`);
		this.name = "PlanError";
	}
}

/** A run that cannot go on: `code` is a fixed identifier safe to record and to return to a caller. */
export class RunError extends Error {
	constructor(
		readonly code: string,
		readonly detail?: string,
	) {
		super(detail ? `${code}: ${detail}` : code);
		this.name = "RunError";
	}
}
