import type { Agent } from "@mastra/core/agent";
import type { z } from "zod";

/*
 * One request with the schema as response format. No tools and no second
 * structuring pass: on a local model that pass cost more than the judging
 * and could run away. For a Claude model it does not know, Mastra falls back
 * to a JSON tool call that can send an array as a string. "outputFormat"
 * forces native mode; other providers ignore it.
 */
export async function judge<S extends z.ZodType>(
  agent: Agent,
  prompt: string,
  schema: S,
): Promise<z.infer<S>> {
  const result = await agent.generate(prompt, {
    structuredOutput: { schema, errorStrategy: "strict" },
    providerOptions: { anthropic: { structuredOutputMode: "outputFormat" } },
  });
  const obj = (result as { object?: unknown }).object;
  if (!obj) throw new Error(`${agent.name}: no structured output`);
  return schema.parse(obj) as z.infer<S>;
}
