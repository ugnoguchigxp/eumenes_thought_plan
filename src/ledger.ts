import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { RunError } from "./errors";
import { canonicalJson, sha256 } from "./plan";

/** Same shape as the Eumenes host's migrations, so the host applies these with its own. */
export interface Migration {
	readonly id: string;
	readonly sql: string;
	readonly after?: readonly string[];
}

/**
 * The database the ledger writes to. The Eumenes host's `SqliteStore` already has this shape; a standalone
 * user gets one from `openLedgerStore`.
 */
export interface LedgerStore {
	read<T>(operation: (db: Database) => T): T;
	write<T>(operation: (db: Database) => T): Promise<T>;
}

/** Applied migrations stay byte for byte; a change is a new migration. */
export const thoughtPlanMigrations: readonly Migration[] = [
	{
		id: "thought-plan/0001-ledger",
		sql: `
CREATE TABLE thought_plan_plans (
  plan_id TEXT NOT NULL, version INTEGER NOT NULL, digest TEXT NOT NULL,
  document_json TEXT NOT NULL, first_used_at_ms INTEGER NOT NULL,
  PRIMARY KEY (plan_id, version)
);
CREATE TABLE thought_plan_runs (
  run_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, plan_version INTEGER NOT NULL, plan_digest TEXT NOT NULL,
  subject_ref TEXT, mode TEXT NOT NULL CHECK (mode IN ('library', 'stepwise')),
  inputs_json TEXT NOT NULL, outputs_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
  error_code TEXT, started_at_ms INTEGER NOT NULL, finished_at_ms INTEGER,
  FOREIGN KEY (plan_id, plan_version) REFERENCES thought_plan_plans (plan_id, version)
);
CREATE INDEX thought_plan_runs_subject ON thought_plan_runs (subject_ref, started_at_ms) WHERE subject_ref IS NOT NULL;
CREATE INDEX thought_plan_runs_plan ON thought_plan_runs (plan_id, started_at_ms);
CREATE TABLE thought_plan_stages (
  run_id TEXT NOT NULL REFERENCES thought_plan_runs (run_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL, stage_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ran', 'skipped', 'failed', 'rejected')),
  skip_reason TEXT, input_json TEXT, system_digest TEXT NOT NULL, output_json TEXT, error_code TEXT,
  model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, latency_ms REAL,
  started_at_ms INTEGER NOT NULL, finished_at_ms INTEGER NOT NULL,
  PRIMARY KEY (run_id, seq)
);
`,
	},
	{
		id: "thought-plan/0002-reuse-context",
		after: ["thought-plan/0001-ledger"],
		sql: `
ALTER TABLE thought_plan_runs ADD COLUMN inputs_digest TEXT;
ALTER TABLE thought_plan_runs ADD COLUMN reused_run_id TEXT;
ALTER TABLE thought_plan_runs ADD COLUMN context_json TEXT;
ALTER TABLE thought_plan_stages ADD COLUMN retryable INTEGER;
CREATE INDEX thought_plan_runs_latest ON thought_plan_runs (subject_ref, plan_digest, started_at_ms) WHERE subject_ref IS NOT NULL;
`,
	},
	{
		id: "thought-plan/0003-rounds",
		after: ["thought-plan/0002-reuse-context"],
		sql: `
ALTER TABLE thought_plan_runs ADD COLUMN rounds INTEGER NOT NULL DEFAULT 1;
ALTER TABLE thought_plan_stages ADD COLUMN round INTEGER NOT NULL DEFAULT 1;
`,
	},
];

export type LedgerMode = "full" | "off";
export type RunMode = "library" | "stepwise";
export type RunStatus = "running" | "completed" | "failed" | "cancelled";
export type StageStatus = "ran" | "skipped" | "failed" | "rejected";

export type PlanRow = {
	readonly id: string;
	readonly version: number;
	readonly digest: string;
	readonly document: unknown;
};
export type RunRow = {
	readonly runId: string;
	readonly planId: string;
	readonly planVersion: number;
	readonly planDigest: string;
	readonly subjectRef: string | null;
	readonly mode: RunMode;
	readonly inputs: Record<string, unknown>;
	readonly outputs: Record<string, unknown> | null;
	readonly status: RunStatus;
	readonly errorCode: string | null;
	readonly startedAtMs: number;
	readonly finishedAtMs: number | null;
	/** SHA-256 of the canonical JSON of the inputs (null on runs recorded before it was kept). */
	readonly inputsDigest: string | null;
	/** The run whose conclusion this run reused without a model call. */
	readonly reusedRunId: string | null;
	/** What the caller attached to the run (never passed to the model). */
	readonly context: Record<string, unknown> | null;
	/** Rounds the run has begun (1 for a run that was never continued). */
	readonly rounds: number;
};
export type StageRow = {
	readonly runId: string;
	readonly seq: number;
	readonly stageId: string;
	readonly status: StageStatus;
	readonly skipReason: string | null;
	readonly input: unknown;
	readonly systemDigest: string;
	readonly output: unknown;
	readonly errorCode: string | null;
	readonly model: string | null;
	readonly inputTokens: number | null;
	readonly outputTokens: number | null;
	readonly cacheReadTokens: number | null;
	readonly latencyMs: number | null;
	/** For a failed stage: whether calling again with the same input may succeed (the model never answered). */
	readonly retryable: boolean | null;
	/** The round of the run the stage ran in (1 when not given). */
	readonly round?: number;
	readonly startedAtMs: number;
	readonly finishedAtMs: number;
};

const json = (value: unknown) =>
	value === undefined ? null : JSON.stringify(value);
const parsed = (text: string | null) =>
	text === null ? null : (JSON.parse(text) as unknown);

/** Records the plan document once per id and version; a different body under the same version is refused. */
export function recordPlanInTransaction(
	db: Database,
	plan: PlanRow,
	nowMs: number,
): void {
	const saved = db
		.query<{ digest: string }, [string, number]>(
			"SELECT digest FROM thought_plan_plans WHERE plan_id = ? AND version = ?",
		)
		.get(plan.id, plan.version);
	if (saved) {
		if (saved.digest !== plan.digest)
			throw new RunError("plan_version_conflict", `${plan.id}@${plan.version}`);
		return;
	}
	db.query(
		"INSERT INTO thought_plan_plans (plan_id, version, digest, document_json, first_used_at_ms) VALUES (?, ?, ?, ?, ?)",
	).run(
		plan.id,
		plan.version,
		plan.digest,
		canonicalJson(plan.document),
		nowMs,
	);
}

export function beginRunInTransaction(
	db: Database,
	run: Omit<
		RunRow,
		| "outputs"
		| "status"
		| "errorCode"
		| "finishedAtMs"
		| "reusedRunId"
		| "rounds"
	>,
): void {
	db.query(
		`INSERT INTO thought_plan_runs (run_id, plan_id, plan_version, plan_digest, subject_ref, mode, inputs_json, status,
		  started_at_ms, inputs_digest, context_json)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
	).run(
		run.runId,
		run.planId,
		run.planVersion,
		run.planDigest,
		run.subjectRef,
		run.mode,
		JSON.stringify(run.inputs),
		run.startedAtMs,
		run.inputsDigest,
		json(run.context ?? undefined),
	);
}

/** A run that takes another run's conclusion: recorded complete at once, with no stages of its own. */
export function recordReuseInTransaction(
	db: Database,
	run: Omit<RunRow, "status" | "errorCode" | "finishedAtMs" | "rounds"> & {
		reusedRunId: string;
	},
): void {
	db.query(
		`INSERT INTO thought_plan_runs (run_id, plan_id, plan_version, plan_digest, subject_ref, mode, inputs_json, outputs_json,
		  status, started_at_ms, finished_at_ms, inputs_digest, reused_run_id, context_json)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?)`,
	).run(
		run.runId,
		run.planId,
		run.planVersion,
		run.planDigest,
		run.subjectRef,
		run.mode,
		JSON.stringify(run.inputs),
		json(run.outputs),
		run.startedAtMs,
		run.startedAtMs,
		run.inputsDigest,
		run.reusedRunId,
		json(run.context ?? undefined),
	);
}

/** The most recent model-driven (`library`) run of a plan body for a subject, whatever its status. */
export function latestRunInTransaction(
	db: Database,
	subjectRef: string,
	planDigest: string,
): RunRow | null {
	const row = db
		.query<RunDbRow, [string, string]>(
			`SELECT * FROM thought_plan_runs WHERE subject_ref = ? AND plan_digest = ? AND mode = 'library'
			 ORDER BY started_at_ms DESC, rowid DESC LIMIT 1`,
		)
		.get(subjectRef, planDigest);
	return row ? runRow(row) : null;
}

/**
 * Closes runs left `running` (a crashed process, an agent that stopped midway) as failed `run_abandoned`:
 * those with no activity (their start or their latest stage) since `idleSinceMs`.
 */
export function abandonRunsInTransaction(
	db: Database,
	filter: { idleSinceMs: number; mode?: RunMode; nowMs: number },
): number {
	return db
		.query(
			`UPDATE thought_plan_runs SET status = 'failed', error_code = 'run_abandoned', finished_at_ms = ?1
			 WHERE status = 'running' AND (?3 IS NULL OR mode = ?3)
			   AND COALESCE(
			     (SELECT MAX(s.finished_at_ms) FROM thought_plan_stages s WHERE s.run_id = thought_plan_runs.run_id),
			     started_at_ms) < ?2`,
		)
		.run(filter.nowMs, filter.idleSinceMs, filter.mode ?? null).changes;
}

/**
 * Deletes finished runs older than the bound with their stages, and the plan bodies no run uses any more.
 * Never called on its own: the host decides when and how far back.
 */
export function pruneRunsInTransaction(
	db: Database,
	filter: { finishedBeforeMs: number },
): { runs: number; plans: number } {
	const old =
		"SELECT run_id FROM thought_plan_runs WHERE status <> 'running' AND finished_at_ms < ?";
	db.query(`DELETE FROM thought_plan_stages WHERE run_id IN (${old})`).run(
		filter.finishedBeforeMs,
	);
	const runs = db
		.query(`DELETE FROM thought_plan_runs WHERE run_id IN (${old})`)
		.run(filter.finishedBeforeMs).changes;
	const plans = db
		.query(
			`DELETE FROM thought_plan_plans WHERE NOT EXISTS (
			   SELECT 1 FROM thought_plan_runs r WHERE r.plan_id = thought_plan_plans.plan_id AND r.plan_version = thought_plan_plans.version)`,
		)
		.run().changes;
	return { runs, plans };
}

/** A stage is recorded only into a run that is still running (not finished, not purged). */
export function recordStageInTransaction(db: Database, stage: StageRow): void {
	const run = db
		.query<{ status: RunStatus }, [string]>(
			"SELECT status FROM thought_plan_runs WHERE run_id = ?",
		)
		.get(stage.runId);
	if (run?.status !== "running")
		throw new RunError(run ? "run_not_running" : "run_unknown");
	db.query(
		`INSERT INTO thought_plan_stages (run_id, seq, stage_id, status, skip_reason, input_json, system_digest, output_json,
		  error_code, model, input_tokens, output_tokens, cache_read_tokens, latency_ms, started_at_ms, finished_at_ms, retryable, round)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		stage.runId,
		stage.seq,
		stage.stageId,
		stage.status,
		stage.skipReason,
		json(stage.input),
		stage.systemDigest,
		json(stage.output),
		stage.errorCode,
		stage.model,
		stage.inputTokens,
		stage.outputTokens,
		stage.cacheReadTokens,
		stage.latencyMs,
		stage.startedAtMs,
		stage.finishedAtMs,
		stage.retryable === null ? null : stage.retryable ? 1 : 0,
		stage.round ?? 1,
	);
}

/** Opens the next round of a completed run: it is running again, with one round more. */
export function reopenRunInTransaction(
	db: Database,
	runId: string,
	round: number,
): void {
	const changed = db
		.query(
			"UPDATE thought_plan_runs SET status = 'running', rounds = ?, finished_at_ms = NULL WHERE run_id = ? AND status = 'completed' AND rounds = ?",
		)
		.run(round, runId, round - 1).changes;
	if (changed !== 1) throw new RunError("run_not_continuable");
}

export function finishRunInTransaction(
	db: Database,
	runId: string,
	end: {
		status: Exclude<RunStatus, "running">;
		outputs: Record<string, unknown> | null;
		errorCode: string | null;
		finishedAtMs: number;
	},
): void {
	db.query(
		"UPDATE thought_plan_runs SET status = ?, outputs_json = ?, error_code = ?, finished_at_ms = ? WHERE run_id = ? AND status = 'running'",
	).run(end.status, json(end.outputs), end.errorCode, end.finishedAtMs, runId);
}

/** Deletes every run (and its stages) recorded for the subject, in the caller's transaction. */
export function purgeSubjectInTransaction(
	db: Database,
	subjectRef: string,
): number {
	db.query(
		"DELETE FROM thought_plan_stages WHERE run_id IN (SELECT run_id FROM thought_plan_runs WHERE subject_ref = ?)",
	).run(subjectRef);
	return db
		.query("DELETE FROM thought_plan_runs WHERE subject_ref = ?")
		.run(subjectRef).changes;
}

type RunDbRow = {
	run_id: string;
	plan_id: string;
	plan_version: number;
	plan_digest: string;
	subject_ref: string | null;
	mode: RunMode;
	inputs_json: string;
	outputs_json: string | null;
	status: RunStatus;
	error_code: string | null;
	started_at_ms: number;
	finished_at_ms: number | null;
	inputs_digest: string | null;
	reused_run_id: string | null;
	context_json: string | null;
	rounds: number;
};
const runRow = (row: RunDbRow): RunRow => ({
	runId: row.run_id,
	planId: row.plan_id,
	planVersion: row.plan_version,
	planDigest: row.plan_digest,
	subjectRef: row.subject_ref,
	mode: row.mode,
	inputs: JSON.parse(row.inputs_json) as Record<string, unknown>,
	outputs: parsed(row.outputs_json) as Record<string, unknown> | null,
	status: row.status,
	errorCode: row.error_code,
	startedAtMs: row.started_at_ms,
	finishedAtMs: row.finished_at_ms,
	inputsDigest: row.inputs_digest,
	reusedRunId: row.reused_run_id,
	context: parsed(row.context_json) as Record<string, unknown> | null,
	rounds: row.rounds,
});

export function readRunInTransaction(
	db: Database,
	runId: string,
): { run: RunRow; stages: StageRow[]; plan: PlanRow } | null {
	const row = db
		.query<RunDbRow, [string]>(
			"SELECT * FROM thought_plan_runs WHERE run_id = ?",
		)
		.get(runId);
	if (!row) return null;
	const plan = db
		.query<
			{
				plan_id: string;
				version: number;
				digest: string;
				document_json: string;
			},
			[string, number]
		>("SELECT * FROM thought_plan_plans WHERE plan_id = ? AND version = ?")
		.get(row.plan_id, row.plan_version)!;
	const stages = db
		.query<Record<string, unknown>, [string]>(
			"SELECT * FROM thought_plan_stages WHERE run_id = ? ORDER BY seq",
		)
		.all(runId)
		.map((stage): StageRow => ({
			runId: stage.run_id as string,
			seq: stage.seq as number,
			stageId: stage.stage_id as string,
			status: stage.status as StageStatus,
			skipReason: stage.skip_reason as string | null,
			input: parsed(stage.input_json as string | null),
			systemDigest: stage.system_digest as string,
			output: parsed(stage.output_json as string | null),
			errorCode: stage.error_code as string | null,
			model: stage.model as string | null,
			inputTokens: stage.input_tokens as number | null,
			outputTokens: stage.output_tokens as number | null,
			cacheReadTokens: stage.cache_read_tokens as number | null,
			latencyMs: stage.latency_ms as number | null,
			retryable:
				stage.retryable === null || stage.retryable === undefined
					? null
					: stage.retryable === 1,
			startedAtMs: stage.started_at_ms as number,
			finishedAtMs: stage.finished_at_ms as number,
			round: stage.round as number,
		}));
	return {
		run: runRow(row),
		stages,
		plan: {
			id: plan.plan_id,
			version: plan.version,
			digest: plan.digest,
			document: JSON.parse(plan.document_json) as unknown,
		},
	};
}

export function listRunsInTransaction(
	db: Database,
	filter: { planId?: string; subjectRef?: string; limit?: number },
): RunRow[] {
	const limit = Math.min(Math.max(1, Math.floor(filter.limit ?? 20)), 200);
	return db
		.query<RunDbRow, [string | null, string | null, number]>(
			`SELECT * FROM thought_plan_runs
			 WHERE (?1 IS NULL OR plan_id = ?1) AND (?2 IS NULL OR subject_ref = ?2)
			 ORDER BY started_at_ms DESC, rowid DESC LIMIT ?3`,
		)
		.all(filter.planId ?? null, filter.subjectRef ?? null, limit)
		.map(runRow);
}

/** What the runners write through. With `mode: "off"` nothing is written and nothing can be read back. */
export interface Ledger {
	readonly mode: LedgerMode;
	write(operation: (db: Database) => void): Promise<void>;
	read<T>(operation: (db: Database) => T): T | null;
	readRun(runId: string): ReturnType<typeof readRunInTransaction>;
	listRuns(filter: Parameters<typeof listRunsInTransaction>[1]): RunRow[];
	purgeSubject(subjectRef: string): Promise<number>;
	latestRun(subjectRef: string, planDigest: string): RunRow | null;
}

export function createLedger(
	store: LedgerStore | null,
	mode: LedgerMode = "full",
): Ledger {
	const active = mode === "full" && store ? store : null;
	return {
		mode: active ? "full" : "off",
		async write(operation) {
			if (!active) return;
			try {
				await active.write(operation);
			} catch (error) {
				// Rules of the ledger keep their code; anything else from the database is not passed on verbatim.
				throw error instanceof RunError
					? error
					: new RunError("ledger_write_failed");
			}
		},
		read: (operation) => (active ? active.read(operation) : null),
		readRun: (runId) =>
			active ? active.read((db) => readRunInTransaction(db, runId)) : null,
		listRuns: (filter) =>
			active ? active.read((db) => listRunsInTransaction(db, filter)) : [],
		latestRun: (subjectRef, planDigest) =>
			active
				? active.read((db) =>
						latestRunInTransaction(db, subjectRef, planDigest),
					)
				: null,
		purgeSubject: async (subjectRef) =>
			active
				? active.write((db) => purgeSubjectInTransaction(db, subjectRef))
				: 0,
	};
}

/** A standalone store: one WAL database file, the ledger's migrations applied, writes serialized. */
export function openLedgerStore(
	path: string,
	migrations: readonly Migration[] = thoughtPlanMigrations,
): LedgerStore & { close(): void } {
	if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path, { create: true, strict: true });
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA foreign_keys = ON");
	db.exec("PRAGMA busy_timeout = 5000");
	// A purged subject's text is overwritten, not left in free pages.
	db.exec("PRAGMA secure_delete = ON");
	applyMigrations(db, migrations);
	let queue: Promise<unknown> = Promise.resolve();
	return {
		read: (operation) => operation(db),
		write<T>(operation: (db: Database) => T) {
			const next = queue.then(() =>
				db.transaction(() => operation(db)).immediate(),
			);
			queue = next.catch(() => undefined);
			return next;
		},
		close: () => db.close(),
	};
}

/** Applies migrations in their `after` order and refuses one whose applied text has changed. */
export function applyMigrations(
	db: Database,
	migrations: readonly Migration[],
): void {
	db.exec(
		"CREATE TABLE IF NOT EXISTS thought_plan_migrations (id TEXT PRIMARY KEY, sql_sha256 TEXT NOT NULL, applied_at_ms INTEGER NOT NULL)",
	);
	const appliedDigest = db.query<{ sql_sha256: string }, [string]>(
		"SELECT sql_sha256 FROM thought_plan_migrations WHERE id = ?",
	);
	const done = new Set<string>();
	const pending = [...migrations];
	while (pending.length) {
		const index = pending.findIndex((m) =>
			(m.after ?? []).every(
				(id) => done.has(id) || !migrations.some((x) => x.id === id),
			),
		);
		if (index < 0) throw new Error("thought_plan_migration_order");
		const [migration] = pending.splice(index, 1);
		const digest = sha256(migration!.sql);
		// Checked and applied under one write lock, so two processes opening the same file apply it once.
		db.transaction(() => {
			const saved = appliedDigest.get(migration!.id)?.sql_sha256;
			if (saved !== undefined) {
				if (saved !== digest)
					throw new Error(`thought_plan_migration_changed:${migration!.id}`);
				return;
			}
			db.exec(migration!.sql);
			db.query(
				"INSERT INTO thought_plan_migrations (id, sql_sha256, applied_at_ms) VALUES (?, ?, ?)",
			).run(migration!.id, digest, Date.now());
		}).immediate();
		done.add(migration!.id);
	}
}
