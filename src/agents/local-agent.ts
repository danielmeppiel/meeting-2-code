import type { CopilotClient, MCPLocalServerConfig, MCPRemoteServerConfig } from "@github/copilot-sdk";
import { createAgentSession } from "./session-helpers.js";

interface LocalGapItem {
    id: number;
    requirement: string;
    gap: string;
    details: string;
    complexity: string;
}

interface LocalAgentResult {
    id: number;
    success: boolean;
    summary: string;
}

interface ExecuteLocalAgentOptions {
    gaps: LocalGapItem[];
    githubMcp: Record<string, MCPLocalServerConfig | MCPRemoteServerConfig>;
    onItemStart?: (id: number, requirement: string) => void;
    onItemProgress?: (id: number, message: string) => void;
    onItemComplete?: (id: number, success: boolean, summary: string) => void;
    onLog?: (message: string) => void;
}

export async function executeLocalAgent(
    client: CopilotClient,
    options: ExecuteLocalAgentOptions,
): Promise<LocalAgentResult[]> {
    const onStart = options.onItemStart ?? (() => {});
    const onProgress = options.onItemProgress ?? (() => {});
    const onComplete = options.onItemComplete ?? (() => {});
    const log = options.onLog ?? (() => {});
    const results: LocalAgentResult[] = [];

    log(`Starting local agent execution for ${options.gaps.length} gap(s)...`);

    for (let i = 0; i < options.gaps.length; i++) {
        const gap = options.gaps[i]!;
        log(`\n── Gap ${i + 1}/${options.gaps.length}: ${gap.requirement.substring(0, 80)} ──`);
        onStart(gap.id, gap.requirement);

        try {
            onProgress(gap.id, "Creating agent session...");
            log("Creating Copilot SDK session with GitHub MCP...");

            const session = await createAgentSession(client, {
                model: "claude-sonnet-4-20250514",
                mcpServers: options.githubMcp,
                systemMessage: {
                    content: `You are a coding agent that implements features in the repository danielmeppiel/corporate-website.
You have access to GitHub MCP tools to read files, create branches, and commit changes.

Your task: Implement the following requirement by making the necessary code changes.
- Create a new feature branch from main
- Read the relevant files to understand the current code
- Make the necessary changes to implement the requirement
- Commit the changes with a clear message

Be thorough but efficient. Focus on the specific gap identified.`,
                },
                label: `local-agent-gap-${gap.id}`,
                onLog: (msg) => {
                    log(msg);
                    onProgress(gap.id, msg);
                },
            });

            onProgress(gap.id, "Sending implementation request to agent...");
            log("Sending task to Copilot agent...");

            const prompt = `
Implement the following requirement in the danielmeppiel/corporate-website repository:

**Requirement:** ${gap.requirement}

**Current Gap:** ${gap.gap}

**Implementation Details:** ${gap.details}

**Complexity:** ${gap.complexity}

Please:
1. Read the relevant source files to understand the current implementation
2. Create a feature branch named "feature/gap-${gap.id}-${gap.requirement.substring(0, 30).replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()}"
3. Make the necessary code changes
4. Commit your changes with a descriptive commit message

Provide a summary of what you implemented when done.`;

            const response = await session.sendAndWait({ prompt }, 300_000);
            const responseContent = response?.data?.content ?? "";
            const summary = responseContent.substring(0, 500) || "Implementation completed";

            await session.destroy();

            log(`✔ Gap #${gap.id} completed successfully`);
            onComplete(gap.id, true, summary);
            results.push({ id: gap.id, success: true, summary });
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.error(`[local-agent] Error on gap #${gap.id}:`, errorMsg);
            log(`✘ Gap #${gap.id} failed: ${errorMsg.substring(0, 200)}`);
            onComplete(gap.id, false, errorMsg.substring(0, 300));
            results.push({ id: gap.id, success: false, summary: errorMsg.substring(0, 300) });
        }
    }

    const successCount = results.filter(r => r.success).length;
    log(`\n✔ Local agent done — ${successCount}/${results.length} gaps completed successfully`);
    return results;
}
