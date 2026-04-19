import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "perplexity.researchPlan",
    {
      title: "Perplexity Research Plan",
      description: "Generate a prompt that routes to the deep research tool.",
      argsSchema: {
        topic: z.string()
      }
    },
    ({ topic }) => ({
      description: `Deep research prompt for ${topic}`,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Use perplexity_research to produce a sourced research brief about "${topic}". Emphasize citations, key findings, and next questions.`
          }
        }
      ]
    })
  );

  server.registerPrompt(
    "perplexity.reasoningPlan",
    {
      title: "Perplexity Reasoning Plan",
      description: "Generate a prompt that routes to the reasoning tool.",
      argsSchema: {
        question: z.string()
      }
    },
    ({ question }) => ({
      description: `Reasoning prompt for ${question}`,
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Use perplexity_reason on the following question and provide the reasoning trace plus a concise final answer: ${question}`
          }
        }
      ]
    })
  );
}
