// Jev tool for any OpenCode model.
//
// Jev (TypeSafe System One) is decision-only: typed Choice/Score/Noul answers,
// no text generation, no tool calls. So it is exposed as a tool, not a model:
// any normal LLM calls `jev_ask` when it needs a calibrated judgment
// (routing, scoring, guardrail) and keeps generating text itself.
//
// Transports (via plugin options in opencode.jsonc):
//   zen (default): OPENCODE_ZEN_API_KEY against https://opencode.ai/zen
//   direct: a TypeSafe key against https://api.typesafe.ai
//     { "package": "/home/<you>/.config/opencode/plugins/jev",
//       "options": { "baseURL": "https://api.typesafe.ai",
//                    "apiKey": "<typesafe key>", "model": "jev-1.13.0" } }

export function buildRequest(
  input: { state: unknown; questions: unknown; model: string },
  baseURL: string,
  apiKey: string,
) {
  const state = typeof input.state === "string" ? { text: input.state } : input.state;
  return {
    url: `${baseURL.replace(/\/$/, "")}/systemone`,
    init: {
      method: "POST",
      // Free tier (jev-1.13-free) needs no key; paid models 401 without one.
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ model: input.model, state, questions: input.questions }),
    } as RequestInit,
  };
}

export default {
  id: "jev",

  async setup(ctx: any) {
    const options = (ctx.options ?? {}) as { model?: string; baseURL?: string; apiKey?: string };
    // ponytail: single hardcoded default; add options only via plugin config when needed.
    const model = options.model ?? "jev-1.13-free";
    const baseURL = options.baseURL ?? "https://opencode.ai/zen/v1";

    await ctx.session.hook("context", (event: any) => {
      event.system.push({ type: "text", text: "Jev decision gates: Route judgments through `jev_ask` (Choice/Score/Noul); generate text and verify numbers yourself. Gate: small state + explicit questions; proceed on confidence >= 0.8, else re-check or ask user. One question per judgment. Transport: `jev-1.13-free` on Zen, no key; key only for paid models." });
    });

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "jev_ask",
        description:
          "Ask Jev (TypeSafe System One) for a fast calibrated decision. " +
          "Pass state (text or object) plus questions: each question is " +
          '{"type":"choice"|"score"|"noul", ...}. ' +
          "Returns typed answers with probabilities. " +
          "Use for routing/scoring/guardrails. NOT for writing text or code — generate that yourself. " +
          "Keep state small; large states degrade accuracy and fail past context limits.",
        input: {
          type: "object",
          properties: {
            state: { description: "Text or object to judge" },
            questions: {
              type: "object",
              description: "Jev questions map, e.g. {dept:{type:'choice',instructions:'...',criteria:{billing:'...',technical:'...'}}}",
            },
            model: { type: "string", description: `Override model (default ${model})` },
          },
          required: ["state", "questions"],
          additionalProperties: false,
        },
        execute: async (input: any) => {
          const apiKey = options.apiKey ?? process.env.OPENCODE_ZEN_API_KEY ?? "";
          const { url, init } = buildRequest(
            { state: input.state, questions: input.questions, model: input.model ?? model },
            baseURL,
            apiKey,
          );
          const res = await fetch(url, init);
          if (!res.ok) throw new Error(`jev_ask: ${res.status} ${await res.text()}`);
          const data = await res.json();
          return { content: JSON.stringify(data.answers ?? data) };
        },
      });
    });
  },
};
