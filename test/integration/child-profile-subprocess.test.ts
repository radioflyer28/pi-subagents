import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const childLaunchUrl = pathToFileURL(path.join(repoRoot, "src", "runs", "shared", "child-launch.ts")).href;
const childSessionUrl = pathToFileURL(path.join(repoRoot, "src", "runs", "shared", "child-session.ts")).href;
const piUrl = pathToFileURL(path.join(repoRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")).href;

describe("strict child profile subprocess", () => {
	it("never imports excluded project extensions and never discovers implicit user/project skills", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-child-profile-subprocess-"));
		try {
			const home = path.join(root, "home");
			const agentDir = path.join(root, "agent");
			const cwd = path.join(root, "project");
			const selectedMarker = path.join(root, "selected.marker");
			const excludedMarker = path.join(root, "excluded.marker");
			const selectedExtension = path.join(root, "selected-extension.ts");
			const selectedSkill = path.join(root, "selected-skill", "SKILL.md");
			const profilePath = path.join(root, "strict-profile.json");
			fs.mkdirSync(path.dirname(selectedSkill), { recursive: true });
			fs.mkdirSync(path.join(home, ".agents", "skills", "implicit-user"), { recursive: true });
			fs.mkdirSync(path.join(cwd, ".pi", "skills", "implicit-project"), { recursive: true });
			fs.mkdirSync(path.join(cwd, ".pi", "extensions"), { recursive: true });
			fs.mkdirSync(agentDir, { recursive: true });
			fs.writeFileSync(path.join(agentDir, "AGENTS.md"), "global sentinel context");
			fs.writeFileSync(path.join(cwd, "AGENTS.md"), "selected project context");
			const selectedSkillContent = "---\nname: selected-review\ndescription: selected\n---\nbody\n";
			const selectedExtensionContent = `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(selectedMarker)}, "selected"); export default function () {}`;
			const profileContent = "{\"name\":\"strict\"}\n";
			fs.writeFileSync(selectedSkill, selectedSkillContent);
			fs.writeFileSync(profilePath, profileContent);
			fs.writeFileSync(path.join(home, ".agents", "skills", "implicit-user", "SKILL.md"), "---\nname: implicit-user\ndescription: user\n---\n");
			fs.writeFileSync(path.join(cwd, ".pi", "skills", "implicit-project", "SKILL.md"), "---\nname: implicit-project\ndescription: project\n---\n");
			fs.writeFileSync(selectedExtension, selectedExtensionContent);
			fs.writeFileSync(path.join(cwd, ".pi", "extensions", "excluded.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(excludedMarker)}, "excluded"); export default function () {}`);
			const script = path.join(root, "run.mjs");
			fs.writeFileSync(script, `
import { buildInProcessChildLaunch } from ${JSON.stringify(childLaunchUrl)};
import { filterResolvedChildProfileContextFiles } from ${JSON.stringify(childSessionUrl)};
import { DefaultResourceLoader, SettingsManager } from ${JSON.stringify(piUrl)};
const profile = {
 version: 1, name: "strict", source: "global", sourcePath: ${JSON.stringify(profilePath)}, profileContentDigest: "sha256:${createHash("sha256").update(profileContent).digest("hex")}", mode: "replace",
 digest: "sha256:${"a".repeat(64)}", isolation: "process",
 resources: {
  tools: [{ name: "read", provenance: "builtin" }],
  skills: [{ name: "selected-review", path: ${JSON.stringify(selectedSkill)}, contentDigest: "sha256:${createHash("sha256").update(selectedSkillContent).digest("hex")}", provenance: { scope: "user", origin: "top-level", source: "test" } }],
  extensions: [{ id: "selected", path: ${JSON.stringify(selectedExtension)}, contentDigest: "sha256:${createHash("sha256").update(selectedExtensionContent).digest("hex")}", provenance: { origin: "path" } }]
 },
 declarations: { tools: "explicit", skills: "explicit", extensions: "explicit" },
 context: { project: true, global: false, projectResources: "deny" },
 compatibility: { profileContract: 1, piProfileSwitch: "prototype" }
};
const launch = buildInProcessChildLaunch({ sessionEnabled: false, inheritProjectContext: true, inheritGlobalContext: false, inheritSkills: false, tools: ["read"], extensions: [${JSON.stringify(selectedExtension)}], cwd: ${JSON.stringify(cwd)}, childAgentName: "reviewer", childIndex: 0, resolvedChildProfile: profile, host: "runner" });
const settingsManager = SettingsManager.create(${JSON.stringify(cwd)}, ${JSON.stringify(agentDir)}, { projectTrusted: true });
const loader = new DefaultResourceLoader({ cwd: launch.session.cwd, agentDir: ${JSON.stringify(agentDir)}, settingsManager, noExtensions: !launch.session.ambientExtensions, noSkills: launch.session.noSkills, noPromptTemplates: true, noThemes: true, noContextFiles: launch.session.noContextFiles, additionalExtensionPaths: launch.session.extensionPaths, additionalSkillPaths: launch.session.skillPaths, extensionFactories: launch.session.hooks, agentsFilesOverride: (base) => filterResolvedChildProfileContextFiles(base, profile, ${JSON.stringify(agentDir)}) });
await loader.reload();
const names = loader.getSkills().skills.map((skill) => skill.name).sort();
const context = loader.getAgentsFiles().agentsFiles.map((file) => file.content);
if (JSON.stringify(names) !== JSON.stringify(["selected-review"])) throw new Error("unexpected skills: " + JSON.stringify(names));
if (JSON.stringify(context) !== JSON.stringify(["selected project context"])) throw new Error("unexpected context: " + JSON.stringify(context));
console.log(JSON.stringify({ names, context, ambientExtensions: launch.session.ambientExtensions, noSkills: launch.session.noSkills }));
`);
			const stdout = execFileSync(process.execPath, ["--experimental-strip-types", script], {
				cwd: repoRoot,
				env: { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir },
				encoding: "utf8",
			});
			assert.equal(fs.readFileSync(selectedMarker, "utf8"), "selected");
			assert.equal(fs.existsSync(excludedMarker), false, stdout);
			assert.match(stdout, /"names":\["selected-review"\]/);
			assert.match(stdout, /"ambientExtensions":false/);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
