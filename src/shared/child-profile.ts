import { createHash } from "node:crypto";
import * as fs from "node:fs";
import type { AgentConfig } from "../agents/agents.ts";
import type { ResolvedSubagentCapabilityCeiling } from "../runs/shared/capability-ceiling.ts";

export interface ResolvedChildProfileV1 {
	version: 1;
	name: string;
	source: "global" | "project";
	sourcePath: string;
	profileContentDigest: `sha256:${string}`;
	mode: "replace";
	digest: `sha256:${string}`;
	isolation: "process" | "session";
	resources: {
		tools: Array<{ name: string; provenance: "builtin" | "declared" }>;
		skills: Array<{ name: string; path: string; contentDigest: `sha256:${string}`; provenance: { scope: string; origin: string; source: string } }>;
		extensions: Array<{ id: string; path: string; contentDigest: `sha256:${string}`; provenance: { origin: string } }>;
	};
	declarations: { tools: "explicit"; skills: "explicit"; extensions: "explicit" };
	context: { project: boolean; global: boolean; projectResources: "deny" | "allow" };
	model?: { provider: string; id: string; thinkingLevel?: string };
	instructions?: string;
	compatibility: { profileContract: 1; piProfileSwitch: string; pi?: string };
}

export interface ChildProfileResolveRequest {
	name: string;
	cwd: string;
	backend: "process" | "session";
}

export interface ChildProfileProvider {
	name: string;
	resolve(request: ChildProfileResolveRequest): Promise<ResolvedChildProfileV1> | ResolvedChildProfileV1;
}

const REGISTRY_KEY = Symbol.for("pi-subagents.child-profile-providers.v1");
interface Registry { providers: Map<string, ChildProfileProvider>; }

function registry(): Registry {
	const root = globalThis as Record<symbol, unknown>;
	let value = root[REGISTRY_KEY] as Registry | undefined;
	if (!value) {
		value = { providers: new Map() };
		root[REGISTRY_KEY] = value;
	}
	return value;
}

export function registerChildProfileProvider(provider: ChildProfileProvider): () => void {
	if (!provider.name.trim()) throw new Error("Child profile provider name is required.");
	const providers = registry().providers;
	const current = { ...provider, name: provider.name.trim() };
	if (providers.has(current.name)) throw new Error(`Child profile provider '${current.name}' is already registered.`);
	providers.set(current.name, current);
	return () => {
		if (providers.get(current.name) === current) providers.delete(current.name);
	};
}

function parseReference(reference: string): { provider?: string; name: string } {
	const trimmed = reference.trim();
	if (!trimmed) throw new Error("profile must be a non-empty name.");
	const separator = trimmed.indexOf(":");
	if (separator < 1) return { name: trimmed };
	const provider = trimmed.slice(0, separator);
	const name = trimmed.slice(separator + 1);
	if (!name) throw new Error("profile must include a non-empty name after provider:.");
	return { provider, name };
}

function nonEmpty(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function assertStringArray(value: unknown, label: string): asserts value is unknown[] {
	if (!Array.isArray(value)) throw new Error(`Resolved child profile ${label} must be an array.`);
}

/** Validate untrusted provider output at the package boundary. */
export function validateResolvedChildProfile(value: unknown): ResolvedChildProfileV1 {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Child profile provider returned a non-object contract.");
	const profile = value as Record<string, any>;
	if (profile.version !== 1 || profile.mode !== "replace") throw new Error("Resolved child profile must use contract version 1 and replace mode.");
	if (!nonEmpty(profile.name) || !nonEmpty(profile.sourcePath) || !/^sha256:[a-f0-9]{64}$/.test(profile.profileContentDigest ?? "") || !/^sha256:[a-f0-9]{64}$/.test(profile.digest ?? "")) throw new Error("Resolved child profile has invalid identity evidence.");
	if (profile.source !== "global" && profile.source !== "project") throw new Error("Resolved child profile source is invalid.");
	if (profile.isolation !== "process" && profile.isolation !== "session") throw new Error("Resolved child profile isolation is invalid.");
	if (!profile.resources || typeof profile.resources !== "object") throw new Error("Resolved child profile resources are required.");
	assertStringArray(profile.resources.tools, "resources.tools");
	assertStringArray(profile.resources.skills, "resources.skills");
	assertStringArray(profile.resources.extensions, "resources.extensions");
	for (const tool of profile.resources.tools) if (!tool || !nonEmpty(tool.name)) throw new Error("Resolved child profile contains an invalid tool.");
	for (const skill of profile.resources.skills) if (!skill || !nonEmpty(skill.name) || !nonEmpty(skill.path) || !/^sha256:[a-f0-9]{64}$/.test(skill.contentDigest ?? "")) throw new Error("Resolved child profile contains an invalid skill.");
	for (const extension of profile.resources.extensions) if (!extension || !nonEmpty(extension.id) || !nonEmpty(extension.path) || !/^sha256:[a-f0-9]{64}$/.test(extension.contentDigest ?? "")) throw new Error("Resolved child profile contains an invalid extension.");
	if (profile.declarations?.tools !== "explicit" || profile.declarations?.skills !== "explicit" || profile.declarations?.extensions !== "explicit") throw new Error("Resolved child profile must explicitly declare tools, skills, and extensions.");
	if (!profile.context || typeof profile.context.project !== "boolean" || typeof profile.context.global !== "boolean" || (profile.context.projectResources !== "deny" && profile.context.projectResources !== "allow")) throw new Error("Resolved child profile context is invalid.");
	if (profile.model !== undefined && (!nonEmpty(profile.model.provider) || !nonEmpty(profile.model.id))) throw new Error("Resolved child profile model is invalid.");
	return structuredClone(profile) as ResolvedChildProfileV1;
}

export async function resolveChildProfileReference(reference: string, request: Omit<ChildProfileResolveRequest, "name">): Promise<ResolvedChildProfileV1> {
	const parsed = parseReference(reference);
	const providers = registry().providers;
	const provider = parsed.provider ? providers.get(parsed.provider) : providers.size === 1 ? [...providers.values()][0] : undefined;
	if (!provider) {
		const detail = parsed.provider ? `provider '${parsed.provider}' is not registered` : providers.size === 0 ? "no child profile provider is registered" : "multiple providers are registered; use provider:name";
		throw new Error(`Cannot resolve child profile '${reference}': ${detail}.`);
	}
	const profile = validateResolvedChildProfile(await provider.resolve({ ...request, name: parsed.name }));
	if (profile.name !== parsed.name) throw new Error(`Child profile provider '${provider.name}' returned '${profile.name}' for requested profile '${parsed.name}'.`);
	return profile;
}

export function verifyResolvedChildProfileResources(profile: ResolvedChildProfileV1): void {
	const resources = [
		{ path: profile.sourcePath, contentDigest: profile.profileContentDigest },
		...profile.resources.skills,
		...profile.resources.extensions,
	];
	for (const resource of resources) {
		let content: Buffer;
		try {
			content = fs.readFileSync(resource.path);
		} catch (error) {
			throw new Error(`Child profile '${profile.name}' resource is unavailable at ${resource.path}: ${error instanceof Error ? error.message : String(error)}`);
		}
		const actual = `sha256:${createHash("sha256").update(content).digest("hex")}`;
		if (actual !== resource.contentDigest) throw new Error(`Child profile '${profile.name}' resource changed after resolution: ${resource.path}. Start a new child with a freshly resolved profile.`);
	}
}

function profileModel(profile: ResolvedChildProfileV1): string | undefined {
	if (!profile.model) return undefined;
	return `${profile.model.provider}/${profile.model.id}${profile.model.thinkingLevel ? `:${profile.model.thinkingLevel}` : ""}`;
}

/** Apply an exact profile while treating the existing agent definition and capability ceiling as restrictions. */
export function applyResolvedChildProfile(input: {
	agent: AgentConfig;
	profile: ResolvedChildProfileV1;
	backend: "process" | "session";
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
}): AgentConfig {
	const { agent, profile, backend, capabilityCeiling } = input;
	if (profile.isolation === "process" && backend !== "process") throw new Error(`Child profile '${profile.name}' requires process isolation; launch with async:true.`);
	if (agent.runner?.type === "external-cli" || agent.runner?.type === "external-job") throw new Error(`Child profile '${profile.name}' requires a native Pi child and cannot be used with runner.type='${agent.runner.type}'.`);
	if (profile.context.projectResources === "allow") throw new Error(`Child profile '${profile.name}' requests trusted project resources, which this prototype cannot enforce exactly.`);
	const tools = profile.resources.tools.map(({ name }) => name);
	const agentToolSet = agent.tools === undefined ? undefined : new Set(agent.tools);
	const excluded = new Set(agent.excludeTools ?? []);
	const widened = tools.filter((tool) => (agentToolSet !== undefined && !agentToolSet.has(tool)) || excluded.has(tool));
	if (widened.length) throw new Error(`Child profile '${profile.name}' would widen agent '${agent.name}' tool restrictions: ${widened.join(", ")}.`);
	if (capabilityCeiling?.allowedTools) {
		const allowed = new Set(capabilityCeiling.allowedTools);
		const denied = tools.filter((tool) => !allowed.has(tool));
		if (denied.length) throw new Error(`Child profile '${profile.name}' conflicts with the active capability ceiling; denied tools: ${denied.join(", ")}.`);
	}
	if (profile.resources.extensions.length > 0 && capabilityCeiling?.denyExtensions) throw new Error(`Child profile '${profile.name}' selects extensions but the active capability ceiling denies extensions.`);
	if (profile.resources.skills.length > 0 && !tools.includes("read")) throw new Error(`Child profile '${profile.name}' selects skills but its exact tool set omits required tool 'read'.`);
	if (profile.context.project && !agent.inheritProjectContext) throw new Error(`Child profile '${profile.name}' would widen agent '${agent.name}' project-context restriction.`);
	if (profile.context.global && !agent.inheritGlobalContext) throw new Error(`Child profile '${profile.name}' would widen agent '${agent.name}' global-context restriction.`);
	const extensionPaths = profile.resources.extensions.map(({ path }) => path);
	const model = profileModel(profile) ?? agent.model;
	const systemPrompt = profile.instructions
		? [agent.systemPrompt, profile.instructions].filter(Boolean).join("\n\n")
		: agent.systemPrompt;
	return {
		...agent,
		...(model ? { model } : {}),
		tools,
		excludeTools: undefined,
		extensions: extensionPaths,
		subagentOnlyExtensions: undefined,
		mcpDirectTools: undefined,
		inheritProjectContext: profile.context.project,
		inheritGlobalContext: profile.context.global,
		inheritSkills: false,
		skills: [],
		...(systemPrompt !== undefined ? { systemPrompt } : {}),
	};
}
