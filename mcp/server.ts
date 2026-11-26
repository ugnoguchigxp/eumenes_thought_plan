import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLedger, openLedgerStore } from "../src/ledger";
import { bundledPlans, loadPlanDirectory, mergePlans } from "../src/plans";
import { defaultConfigPath, readServerConfig } from "./config";
import { createThoughtPlanServer } from "./tools";

// `bun mcp/server.ts [--config <path>]`: stdio only; nothing but MCP messages goes to stdout.
const flag = process.argv.indexOf("--config");
const configPath = flag >= 0 ? process.argv[flag + 1] : defaultConfigPath;
if (!configPath) throw new Error("thought_plan_config_path_missing");
const config = readServerConfig(configPath);
const store =
	config.ledger.mode === "full" ? openLedgerStore(config.ledger.path) : null;
const server = createThoughtPlanServer({
	plans: mergePlans(
		bundledPlans(),
		...config.planDirectories.map((dir) => loadPlanDirectory(dir)),
	),
	ledger: createLedger(store, config.ledger.mode),
});
await server.connect(new StdioServerTransport());
