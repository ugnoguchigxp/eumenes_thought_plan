/** Daily check: format, lint, types, deterministic tests. Stops at the first failing step. */
const steps = [["format:check"], ["lint"], ["typecheck"], ["test"]];
for (const step of steps) {
	const child = Bun.spawn([process.execPath, "run", ...step], {
		stdout: "inherit",
		stderr: "inherit",
	});
	const code = await child.exited;
	if (code !== 0) process.exit(code);
}
console.log("OK: format, lint, types and tests.");

export {};
