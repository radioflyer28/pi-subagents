import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";

import { applyResolvedChildProfile, registerChildProfileProvider, resolveChildProfileReference, type ResolvedChildProfileV1 } from "../../src/api/child-profiles.ts";
import { buildInProcessChildLaunch } from "../../src/runs/shared/child-launch.ts";
import { createDefaultChildSessionFactory, filterResolvedChildProfileContextFiles, type PiCodingAgentModule } from "../../src/runs/shared/child-session.ts";
import { makeAgent } from "../support/helpers.ts";

function contract(name = "lean", overrides: Partial<ResolvedChildProfileV1> = {}): ResolvedChildProfileV1 {
	return {
		version: 1,
		name,
		source: "global",
		sourcePath: `/profiles/${name}.json`,
		profileContentDigest: `sha256:${"e".repeat(64)}`,
		mode: "replace",
		digest: `sha256:${"a".repeat(64)}`,
		isolation: "process",
		resources: { tools: [{ name: "read", provenance: "builtin" }], skills: [], extensions: [] },
		declarations: { tools: "explicit", skills: "explicit", extensions: "explicit" },
		context: { project: false, global: false, projectResources: "deny" },
		compatibility: { profileContract: 1, piProfileSwitch: "prototype" },
		...overrides,
	};
}

describe("child profile provider registry", () => {
	it("resolves an immutable provider snapshot by name", async () => {
		const dispose = registerChildProfileProvider({ name: "test", resolve: ({ name }) => contract(name) });
		try {
			const resolved = await resolveChildProfileReference("lean", { cwd: process.cwd(), backend: "process" });
			assert.equal(resolved.name, "lean");
			assert.notEqual(resolved.resources, contract().resources);
		} finally { dispose(); }
	});

	it("fails closed without a provider or with ambiguous providers", async () => {
		await assert.rejects(() => resolveChildProfileReference("lean", { cwd: process.cwd(), backend: "process" }), /no child profile provider/);
		const a = registerChildProfileProvider({ name: "a", resolve: () => contract() });
		assert.throws(() => registerChildProfileProvider({ name: "a", resolve: () => contract() }), /already registered/);
		await assert.rejects(() => resolveChildProfileReference("a:", { cwd: process.cwd(), backend: "process" }), /non-empty name/);
		const b = registerChildProfileProvider({ name: "b", resolve: () => contract() });
		try {
			await assert.rejects(() => resolveChildProfileReference("lean", { cwd: process.cwd(), backend: "process" }), /multiple providers/);
			assert.equal((await resolveChildProfileReference("a:lean", { cwd: process.cwd(), backend: "process" })).name, "lean");
		} finally { a(); b(); }
	});
});

describe("child profile enforcement", () => {
	it("applies exact resources without allowing agent or ambient widening", () => {
		const profile = contract("review", {
			isolation: "session",
			resources: {
				tools: [{ name: "read", provenance: "builtin" }],
				skills: [{ name: "review", path: "/skills/review/SKILL.md", contentDigest: `sha256:${"b".repeat(64)}`, provenance: { scope: "user", origin: "top-level", source: "auto" } }],
				extensions: [{ id: "guard", path: "/ext/guard.ts", contentDigest: `sha256:${"c".repeat(64)}`, provenance: { origin: "local" } }],
			},
		});
		const agent = applyResolvedChildProfile({ agent: makeAgent("reviewer", { tools: ["read", "grep"], extensions: ["/ambient.ts"], subagentOnlyExtensions: ["/extra.ts"] }), profile, backend: "session" });
		assert.deepEqual(agent.tools, ["read"]);
		assert.deepEqual(agent.extensions, ["/ext/guard.ts"]);
		assert.equal(agent.subagentOnlyExtensions, undefined);
		assert.equal(agent.inheritSkills, false);
		assert.deepEqual(agent.skills, []);
	});

	it("filters global and project context independently", () => {
		const agentDir = "/home/test/.pi/agent";
		const base = { agentsFiles: [
			{ path: `${agentDir}/AGENTS.md`, content: "global" },
			{ path: "/project/AGENTS.md", content: "project" },
		] };
		const projectOnly = contract("project", { context: { project: true, global: false, projectResources: "deny" } });
		const globalOnly = contract("global", { context: { project: false, global: true, projectResources: "deny" } });
		assert.deepEqual(filterResolvedChildProfileContextFiles(base, projectOnly, agentDir).agentsFiles.map(({ content }) => content), ["project"]);
		assert.deepEqual(filterResolvedChildProfileContextFiles(base, globalOnly, agentDir).agentsFiles.map(({ content }) => content), ["global"]);
	});

	it("rejects backend downgrade, agent widening, and capability-ceiling conflicts", () => {
		assert.throws(() => applyResolvedChildProfile({ agent: makeAgent("reviewer", { tools: ["read"] }), profile: contract(), backend: "session" }), /requires process isolation/);
		assert.throws(() => applyResolvedChildProfile({ agent: makeAgent("reviewer", { tools: ["grep"] }), profile: contract(), backend: "process" }), /would widen/);
		assert.throws(() => applyResolvedChildProfile({ agent: makeAgent("reviewer", { tools: ["read"] }), profile: contract(), backend: "process", capabilityCeiling: { version: 1, allowedTools: ["grep"], denyExtensions: false, sources: ["test"] } }), /denied tools: read/);
	});

	it("threads exact skill paths through the common child loader contract", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-profile-unit-"));
		try {
			const skillPath = path.join(root, "SKILL.md");
			const sourcePath = path.join(root, "skills.json");
			const content = "---\nname: review\ndescription: review\n---\n";
			const profileContent = "{\"name\":\"skills\"}\n";
			fs.writeFileSync(skillPath, content);
			fs.writeFileSync(sourcePath, profileContent);
			const profile = contract("skills", {
				sourcePath,
				profileContentDigest: `sha256:${createHash("sha256").update(profileContent).digest("hex")}`,
				resources: {
					tools: [{ name: "read", provenance: "builtin" }],
					skills: [{ name: "review", path: skillPath, contentDigest: `sha256:${createHash("sha256").update(content).digest("hex")}`, provenance: { scope: "user", origin: "top-level", source: "auto" } }],
					extensions: [],
				},
			});
			const launch = buildInProcessChildLaunch({
				sessionEnabled: false,
				inheritProjectContext: false,
				inheritGlobalContext: false,
				inheritSkills: false,
				tools: ["read"],
				extensions: [],
				cwd: process.cwd(),
				childAgentName: "reviewer",
				childIndex: 0,
				resolvedChildProfile: profile,
				host: "runner",
			});
			assert.equal(launch.session.noSkills, true);
			assert.equal(launch.session.ambientExtensions, false);
			assert.deepEqual(launch.session.skillPaths, [skillPath]);
			assert.equal(launch.session.resolvedChildProfile?.digest, profile.digest);
			let loaderOptions: { additionalSkillPaths?: string[]; skillsOverride?: (base: { skills: Array<{ name: string; filePath: string }> }) => { skills: Array<{ name: string; filePath: string }> } } | undefined;
			const factory = createDefaultChildSessionFactory({ loadPiCodingAgent: async () => ({
				ModelRuntime: { create: async () => ({}) },
				SettingsManager: { create: () => ({}) },
				DefaultResourceLoader: class {
					constructor(options: typeof loaderOptions) { loaderOptions = options; }
					async reload() {}
				},
				SessionManager: { inMemory: () => ({}) },
				resolveCliModel: () => ({}),
				createAgentSession: async () => ({ session: {
					bindExtensions: async () => {}, abort: async () => {}, dispose() {},
					extensionRunner: { hasHandlers: () => false },
					subscribe: () => () => {}, messages: [], sessionId: "profile-skills",
				} }),
			} as unknown as PiCodingAgentModule) });
			try {
				await factory.create(launch.session);
				assert.deepEqual(loaderOptions?.additionalSkillPaths, [skillPath]);
				const selected = { name: "review", filePath: skillPath };
				const ambient = { name: "ambient", filePath: path.join(root, "ambient", "SKILL.md") };
				assert.deepEqual(loaderOptions?.skillsOverride?.({ skills: [selected, ambient] }).skills, [selected], "keep exact profile skills without reintroducing extension-discovered skills");
			} finally { await factory.dispose(); }
			fs.writeFileSync(skillPath, `${content}changed\n`);
			assert.throws(() => buildInProcessChildLaunch({ sessionEnabled: false, inheritProjectContext: false, inheritGlobalContext: false, inheritSkills: false, tools: ["read"], extensions: [], cwd: process.cwd(), childAgentName: "reviewer", childIndex: 0, resolvedChildProfile: profile, host: "runner" }), /resource changed after resolution/);
		} finally { fs.rmSync(root, { recursive: true, force: true }); }
	});
});
