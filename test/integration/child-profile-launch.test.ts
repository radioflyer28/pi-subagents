import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import * as path from "node:path";

import { registerChildProfileProvider, type ResolvedChildProfileV1 } from "../../src/api/child-profiles.ts";
import { makeAgent, makeMinimalCtx } from "../support/helpers.ts";
import { available, installSingleExecutionHooks, makeExecutor, mockPi, readAllCallArgs, readCall, tempDir } from "../support/single-execution-fixture.ts";

function profile(name: string, tools: string[]): ResolvedChildProfileV1 {
	const skillPath = path.join(tempDir, `${name}-SKILL.md`);
	const skillContent = `---\nname: ${name}-skill\ndescription: test\n---\nbody\n`;
	const sourcePath = path.join(tempDir, `${name}-profile.json`);
	const profileContent = JSON.stringify({ name, tools });
	fs.writeFileSync(skillPath, skillContent);
	fs.writeFileSync(sourcePath, profileContent);
	return {
		version: 1,
		name,
		source: "global",
		sourcePath,
		profileContentDigest: `sha256:${createHash("sha256").update(profileContent).digest("hex")}`,
		mode: "replace",
		digest: `sha256:${(name === "reader" ? "a" : "b").repeat(64)}`,
		isolation: "session",
		resources: {
			tools: tools.map((tool) => ({ name: tool, provenance: "builtin" as const })),
			skills: [{ name: `${name}-skill`, path: skillPath, contentDigest: `sha256:${createHash("sha256").update(skillContent).digest("hex")}`, provenance: { scope: "user", origin: "top-level", source: "test" } }],
			extensions: [],
		},
		declarations: { tools: "explicit", skills: "explicit", extensions: "explicit" },
		context: { project: false, global: false, projectResources: "deny" },
		compatibility: { profileContract: 1, piProfileSwitch: "prototype" },
	};
}

describe("public child profile launch", { skip: !available ? "pi packages not available" : undefined }, () => {
	installSingleExecutionHooks();

	it("resolves profile before a foreground child and leaves the parent agent definition unchanged", async () => {
		const original = makeAgent("reviewer", { tools: ["read", "grep"], skills: ["parent-skill"], inheritSkills: true, extensions: ["/ambient-parent.ts"], subagentOnlyExtensions: ["/parent-child-only.ts"] });
		const dispose = registerChildProfileProvider({ name: "fixture", resolve: ({ name }) => profile(name, ["read"]) });
		try {
			mockPi.onCall({ output: "reviewed" });
			const executor = makeExecutor([original]);
			const result = await executor.execute("profiled", { agent: "reviewer", task: "Review", profile: "reader", async: false }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			assert.equal(result.isError, undefined, result.content[0]?.text ?? "profile launch failed");
			const call = readCall();
			assert.deepEqual(call.launch?.tools, ["read"]);
			assert.deepEqual(call.launch?.extensionPaths.filter((entry) => entry === "/ambient-parent.ts"), []);
			assert.equal(call.launch?.ambientExtensions, false);
			assert.deepEqual(call.launch?.skillPaths, [path.join(tempDir, "reader-SKILL.md")]);
			assert.equal(call.launch?.noSkills, true);
			assert.equal(call.launch?.resolvedChildProfile?.name, "reader");
			assert.deepEqual(original.tools, ["read", "grep"]);
			assert.deepEqual(original.skills, ["parent-skill"]);
			assert.equal(original.inheritSkills, true);
			assert.deepEqual(original.extensions, ["/ambient-parent.ts"]);
			assert.deepEqual(original.subagentOnlyExtensions, ["/parent-child-only.ts"]);
		} finally { dispose(); }
	});

	it("launches concurrent workflow children with different immutable profiles", async () => {
		const dispose = registerChildProfileProvider({ name: "fixture", resolve: ({ name }) => profile(name, name === "reader" ? ["read"] : ["read", "grep"]) });
		try {
			const releasePath = path.join(tempDir, "release-concurrent-profiles");
			mockPi.onCall({ output: "read", waitForPath: releasePath });
			mockPi.onCall({ output: "search", waitForPath: releasePath });
			const executor = makeExecutor([makeAgent("reviewer", { tools: ["read", "grep"] })]);
			let observedBothBeforeRelease = false;
			const deadline = Date.now() + 3_000;
			const releaseWatcher = setInterval(() => {
				if (readAllCallArgs().length === 2) observedBothBeforeRelease = true;
				if (observedBothBeforeRelease || Date.now() >= deadline) {
					fs.writeFileSync(releasePath, "release");
					clearInterval(releaseWatcher);
				}
			}, 10);
			const result = await executor.execute("profile-workflow", {
				async: false,
				workflowScript: `
					const children = await runs.all([
						{ key: "reader", agent: "reviewer", profile: "reader", task: "Read" },
						{ key: "searcher", agent: "reviewer", profile: "searcher", task: "Search" }
					]);
					return children.map((child) => child.key);
				`,
			}, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			clearInterval(releaseWatcher);
			assert.equal(result.isError, undefined, result.content[0]?.text ?? "profile workflow failed");
			const calls = readAllCallArgs();
			assert.equal(calls.length, 2);
			const toolSets = calls.map((args) => args[args.indexOf("--tools") + 1]).sort();
			assert.deepEqual(toolSets, ["read", "read,grep"]);
			assert.equal(calls.every((args) => args.includes("--no-skills") && args.includes("--no-extensions")), true);
			assert.equal(observedBothBeforeRelease, true, "the second child did not start while the first child was blocked");
		} finally { dispose(); }
	});

	it("fails before model launch when resolution fails", async () => {
		const dispose = registerChildProfileProvider({ name: "fixture", resolve: () => { throw new Error("missing profile fixture"); } });
		try {
			const executor = makeExecutor([makeAgent("reviewer", { tools: ["read"] })]);
			const result = await executor.execute("missing-profile", { agent: "reviewer", task: "Review", profile: "missing", async: false }, new AbortController().signal, undefined, makeMinimalCtx(tempDir));
			assert.equal(result.isError, true);
			assert.match(result.content[0]?.text ?? "", /missing profile fixture/);
			assert.equal(mockPi.callCount(), 0);
		} finally { dispose(); }
	});
});
