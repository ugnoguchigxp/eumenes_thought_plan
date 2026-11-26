import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	abandonRunsInTransaction,
	createLedger,
	openLedgerStore,
} from "../src/ledger";
import { bundledPlans, mergePlans, scanPlanDirectory } from "../src/plans";
import { defaultConfigPath, readServerConfig } from "./config";
import { createThoughtPlanServer } from "./tools";

/** A stepwise run nobody has advanced for this long was left by an agent that stopped midway. */
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;

// `bun mcp/server.ts [--config <path>]`: stdio only; nothing but MCP messages goes to stdout.
const flag = process.argv.indexOf("--config");
const configPath = flag >= 0 ? process.argv[flag + 1] : defaultConfigPath;
if (!configPath) throw new Error("thought_plan_config_path_missing");
const config = readServerConfig(configPath);
const store =
	config.ledger.mode === "full" ? openLedgerStore(config.ledger.path) : null;
if (store) {
	const nowMs = Date.now();
	await store.write((db) =>
		abandonRunsInTransaction(db, {
			idleSinceMs: nowMs - ABANDONED_AFTER_MS,
			mode: "stepwise",
			nowMs,
		}),
	);
}
// Bundled plans must load; a broken file in a configured directory is reported by list_plans instead.
const scanned = config.planDirectories.map((dir) => scanPlanDirectory(dir));
const server = createThoughtPlanServer({
	plans: mergePlans(bundledPlans(), ...scanned.map(({ plans }) => plans)),
	invalid: scanned.flatMap(({ invalid }) => invalid),
	ledger: createLedger(store, config.ledger.mode),
});
await server.connect(new StdioServerTransport());
