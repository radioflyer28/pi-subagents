import assert from "node:assert/strict";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels, fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";

export default function(pi) {
	const state = globalThis.__sdkSmoke;
	assert.equal(AgentSession, state.AgentSession);
	assert.equal(Agent, state.Agent);
	assert.equal(createModels, state.createModels);
	state.faux = fauxProvider({ provider: "sdk-smoke", models: [{ id: "local" }], tokensPerSecond: 100000 });
	state.faux.setResponses([fauxAssistantMessage("local response verified")]);
	pi.registerProvider(state.faux.provider);
	pi.on("session_start", () => { state.started++; });
	pi.on("session_shutdown", () => { state.stopped++; });
}
