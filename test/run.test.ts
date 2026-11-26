import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
	applyMigrations,
	createLedger,
	loadPlan,
	openLedgerStore,
	purgeSubjectInTransaction,
	runPlan,
	thoughtPlanMigrations,
	type LedgerStore,
} from "../src/index";
import { fakeLlm, twoStagePlan } from "./fixture";

const plan = loadPlan(twoStagePlan);
const answers = (request: { system: string }) =>
	request.system === "判断する。"
		? { decision: "go", reason: "進められる" }
		: { steps: ["読む", "試す"] };

const count = (store: LedgerStore, table: string) =>
	store.read(
		(db) =>
			db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()!
				.n,
	);

test("each stage runs once in order with its own system context and wired input", async () => {
	const { llm, calls } = fakeLlm(answers);
	const result = await runPlan(
		plan,
		{ question: "背景色", known: false },
		{ llm },
	);
	expect(result.status).toBe("completed");
	expect(result.outputs).toEqual({ decision: "go", steps: ["読む", "試す"] });
	expect(calls.map(({ system }) => system)).toEqual([
		"判断する。",
		"計画する。",
	]);
	expect(JSON.parse(calls[1]!.prompt)).toEqual({
		question: "背景色",
		judgment: { decision: "go", reason: "進められる" },
	});
	expect(calls.every(({ purpose }) => purpose === "think")).toBe(true);
});

test("a skipped stage costs no model call, and what depends on it reads null", async () => {
	const { llm, calls } = fakeLlm(answers);
	const result = await runPlan(
		plan,
		{ question: "背景色", known: true },
		{ llm },
	);
	expect(calls).toHaveLength(0);
	expect(result.stages.map(({ status, reason }) => [status, reason])).toEqual([
		["skipped", "skip_when_met"],
		["skipped", "run_when_unmet"],
	]);
	expect(result.outputs).toEqual({ decision: null, steps: null });
});

test("an output off its schema fails the stage and stops the run", async () => {
	const { llm, calls } = fakeLlm(() => ({ decision: "maybe", reason: "" }));
	const result = await runPlan(plan, { question: "q", known: false }, { llm });
	expect(result.status).toBe("failed");
	expect(result.errorCode).toBe("stage_output_invalid");
	expect(calls).toHaveLength(1);
	expect(result.outputs).toBeNull();
});

test("bad inputs are refused before anything runs or is recorded", async () => {
	const store = openLedgerStore(":memory:");
	const { llm } = fakeLlm(answers);
	await expect(
		runPlan(
			plan,
			{ question: 3, known: false },
			{ llm, ledger: createLedger(store) },
		),
	).rejects.toThrow("inputs_invalid");
	expect(count(store, "thought_plan_runs")).toBe(0);
});

test("an aborted run is recorded as cancelled", async () => {
	const store = openLedgerStore(":memory:");
	const controller = new AbortController();
	const { llm } = fakeLlm(() => {
		controller.abort();
		throw new Error("aborted");
	});
	const result = await runPlan(
		plan,
		{ question: "q", known: false },
		{ llm, ledger: createLedger(store), signal: controller.signal },
	);
	expect(result.status).toBe("cancelled");
	expect(
		store.read((db) => db.query("SELECT status FROM thought_plan_runs").get()),
	).toEqual({ status: "cancelled" });
});

test("the full ledger keeps every input and output; off writes nothing", async () => {
	const store = openLedgerStore(":memory:");
	const { llm } = fakeLlm(answers);
	const full = await runPlan(
		plan,
		{ question: "背景色", known: false },
		{ llm, ledger: createLedger(store, "full"), subjectRef: "goal:1" },
	);
	const saved = createLedger(store).readRun(full.runId)!;
	expect(saved.run).toMatchObject({
		status: "completed",
		subjectRef: "goal:1",
		mode: "library",
		inputs: { question: "背景色", known: false },
		outputs: { decision: "go", steps: ["読む", "試す"] },
	});
	expect(
		saved.stages.map(({ stageId, status, model }) => [stageId, status, model]),
	).toEqual([
		["judge", "ran", "fixture"],
		["plan", "ran", "fixture"],
	]);
	expect(saved.stages[1]!.input).toEqual({
		question: "背景色",
		judgment: { decision: "go", reason: "進められる" },
	});
	expect(saved.plan.digest).toBe(plan.digest);

	const before = count(store, "thought_plan_stages");
	await runPlan(
		plan,
		{ question: "q", known: false },
		{
			llm,
			ledger: createLedger(store, "off"),
		},
	);
	expect(count(store, "thought_plan_stages")).toBe(before);
	expect(createLedger(store, "off").listRuns({})).toEqual([]);
});

test("a subject's runs are purged with their stages", async () => {
	const store = openLedgerStore(":memory:");
	const ledger = createLedger(store);
	const { llm } = fakeLlm(answers);
	for (const subjectRef of ["goal:1", "goal:1", "goal:2"])
		await runPlan(
			plan,
			{ question: "q", known: false },
			{ llm, ledger, subjectRef },
		);
	expect(await ledger.purgeSubject("goal:1")).toBe(2);
	expect(ledger.listRuns({}).map(({ subjectRef }) => subjectRef)).toEqual([
		"goal:2",
	]);
	expect(count(store, "thought_plan_stages")).toBe(2);
});

test("the same plan version with another body is refused by the ledger", async () => {
	const store = openLedgerStore(":memory:");
	const ledger = createLedger(store);
	const { llm } = fakeLlm(answers);
	await runPlan(plan, { question: "q", known: false }, { llm, ledger });
	const changed = loadPlan({ ...twoStagePlan, description: "別の本文" });
	await expect(
		runPlan(changed, { question: "q", known: false }, { llm, ledger }),
	).rejects.toThrow("plan_version_conflict");
});

/**
 * The Eumenes host applies `thoughtPlanMigrations` with its own and hands over its store (read / async write):
 * the ledger lives in the host's database next to the host's tables and joins the host's transactions.
 */
test("the ledger runs inside a host database and its transactions", async () => {
	const db = new Database(":memory:", { strict: true });
	db.exec("PRAGMA foreign_keys = ON");
	applyMigrations(db, [
		{
			id: "host/0001",
			sql: "CREATE TABLE host_goals (id TEXT PRIMARY KEY, note TEXT)",
		},
		...thoughtPlanMigrations.map((m) => ({ ...m, after: ["host/0001"] })),
	]);
	let writes = 0;
	const host: LedgerStore & { onCommit(): () => void } = {
		read: (operation) => operation(db),
		async write(operation) {
			writes++;
			return db.transaction(() => operation(db))();
		},
		onCommit: () => () => {},
	};
	const ledger = createLedger(host);
	const { llm } = fakeLlm(answers);
	const result = await runPlan(
		plan,
		{ question: "q", known: false },
		{
			llm,
			ledger,
			subjectRef: "goal:host",
		},
	);
	expect(result.status).toBe("completed");
	expect(writes).toBeGreaterThan(0);
	await host.write((tx) => {
		tx.query(
			"INSERT INTO host_goals (id, note) VALUES ('host', 'forget')",
		).run();
		purgeSubjectInTransaction(tx, "goal:host");
	});
	expect(ledger.listRuns({ subjectRef: "goal:host" })).toEqual([]);
	expect(
		db
			.query(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'thought_plan_%' ORDER BY name",
			)
			.all(),
	).toEqual([
		{ name: "thought_plan_migrations" },
		{ name: "thought_plan_plans" },
		{ name: "thought_plan_runs" },
		{ name: "thought_plan_stages" },
	]);
	expect(() =>
		applyMigrations(db, [
			{
				...thoughtPlanMigrations[0]!,
				sql: `${thoughtPlanMigrations[0]!.sql}\n`,
			},
		]),
	).toThrow("thought_plan_migration_changed");
});
