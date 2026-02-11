import type { CopilotClient, MCPLocalServerConfig, MCPRemoteServerConfig } from "@github/copilot-sdk";

/**
 * Creates a session with auto-approved permissions and tool-call logging.
 * Without onPermissionRequest, MCP tool calls may be silently blocked.
 */
export async function createAgentSession(
    client: CopilotClient,
    options: {
        model: string;
        mcpServers: Record<string, MCPLocalServerConfig | MCPRemoteServerConfig>;
        systemMessage: { content: string };
        label: string;
        workingDirectory?: string;
        onLog?: (message: string) => void;
    },
) {
    const log = options.onLog ?? (() => {});
    const label = options.label;

    const session = await client.createSession({
        model: options.model,
        mcpServers: options.mcpServers,
        systemMessage: options.systemMessage,
        ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}),
        onPermissionRequest: async (req) => {
            console.log(`[${label}] Permission requested: ${req.kind}`, JSON.stringify(req).substring(0, 200));
            log(`Permission auto-approved: ${req.kind}`);
            return { kind: "approved" };
        },
        hooks: {
            onPreToolUse: async (input) => {
                console.log(`[${label}] Tool call → ${input.toolName}(${JSON.stringify(input.toolArgs).substring(0, 200)})`);
                log(`Calling tool: ${input.toolName}`);
                return { permissionDecision: "allow" };
            },
            onPostToolUse: async (input) => {
                const resultPreview = JSON.stringify(input.toolResult).substring(0, 200);
                console.log(`[${label}] Tool result ← ${input.toolName}: ${resultPreview}`);
                log(`Tool ${input.toolName} returned`);
            },
        },
    });

    // Log all events for debugging  
    session.on((event: { type: string; data?: unknown }) => {
        if (event.type.startsWith("tool.")) {
            console.log(`[${label}] Event: ${event.type}`, JSON.stringify(event.data).substring(0, 300));
        }
    });

    return session;
}
