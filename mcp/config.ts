import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

const configSchema = z
	.object({
		ledger: z
			.object({
				mode: z.enum(["full", "off"]),
				path: z.string().min(1),
			})
			.strict(),
		/** Directories of plan documents besides the bundled ones. */
		planDirectories: z.array(z.string().min(1)),
	})
	.strict();
export type ServerConfig = z.infer<typeof configSchema>;

export const defaultConfigPath = join(
	import.meta.dir,
	"..",
	"config",
	"thought-plan.json",
);

/** Reads the server configuration; relative paths in it resolve against the file's directory. */
export function readServerConfig(path = defaultConfigPath): ServerConfig {
	if (!existsSync(path)) throw new Error(`thought_plan_config_missing:${path}`);
	const config = configSchema.parse(JSON.parse(readFileSync(path, "utf8")));
	const base = dirname(resolve(path));
	const at = (value: string) =>
		isAbsolute(value) ? value : resolve(base, value);
	return {
		ledger: {
			mode: config.ledger.mode,
			path:
				config.ledger.mode === "full"
					? at(config.ledger.path)
					: config.ledger.path,
		},
		planDirectories: config.planDirectories.map(at),
	};
}
