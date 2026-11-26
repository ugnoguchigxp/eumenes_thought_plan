/**
 * Packs the package source for vendoring into a host (Bun runs the TypeScript as it is).
 *
 *   bun scripts/pack.ts               write artifacts/pack/<tgz>, <tgz>.sha256 and manifest.json
 *   bun scripts/pack.ts --out <dir>   write elsewhere
 */
import { createHash } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const flag = process.argv.indexOf("--out");
const out = resolve(
	flag >= 0 ? process.argv[flag + 1]! : join(root, "artifacts", "pack"),
);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const run = (argv: string[]) => {
	const child = Bun.spawnSync(argv, {
		cwd: root,
		stderr: "pipe",
		stdout: "pipe",
	});
	if (child.exitCode !== 0)
		throw new Error(`${argv.join(" ")} failed: ${child.stderr.toString()}`);
	return child.stdout.toString().trim();
};

const commit = run(["git", "rev-parse", "HEAD"]);
const dirty = run(["git", "status", "--porcelain"]) !== "";
run([process.execPath, "pm", "pack", "--destination", out, "--quiet"]);
const file = readdirSync(out).find((name) => name.endsWith(".tgz"));
if (!file) throw new Error("pack_tgz_missing");
const sha256 = createHash("sha256")
	.update(readFileSync(join(out, file)))
	.digest("hex");
const listing = run(["tar", "-tzf", join(out, file)]).split("\n");
for (const required of [
	"package/src/index.ts",
	"package/mcp/server.ts",
	"package/plans/review-judge-plan.json",
	"package/LICENSE",
])
	if (!listing.includes(required))
		throw new Error(`pack_file_missing:${required}`);
// The model settings are for running this package alone; a host brings its own.
if (listing.includes("package/config/llm.json"))
	throw new Error("pack_file_unexpected:package/config/llm.json");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
	name: string;
	version: string;
};
writeFileSync(join(out, `${file}.sha256`), `${sha256}  ${file}\n`);
writeFileSync(
	join(out, "manifest.json"),
	`${JSON.stringify(
		{
			name: pkg.name,
			version: pkg.version,
			file,
			sha256,
			sourceCommit: commit,
			sourceDirty: dirty,
			files: listing.length,
		},
		null,
		"\t",
	)}\n`,
);
console.log(`${file} ${sha256}${dirty ? " (from a dirty tree)" : ""}`);
