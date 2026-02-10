import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { CopilotClient } from "@github/copilot-sdk";
import type { MCPLocalServerConfig, MCPRemoteServerConfig } from "@github/copilot-sdk";
import { analyzeMeetingGaps } from "./agents/gap-analyzer.js";
import { createGithubIssues } from "./agents/github-issues.js";
import { assignCodingAgent } from "./agents/coding-agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// ─── Copilot SDK Client (singleton) ───────────────────────────────────────────
const client = new CopilotClient({ logLevel: "debug" });

// ─── State ────────────────────────────────────────────────────────────────────
interface GapItem {
    id: number;
    requirement: string;
    currentState: string;
    gap: string;
    complexity: "Low" | "Medium" | "High" | "Critical";
    estimatedEffort: string;
    details: string;
}

let lastAnalysis: GapItem[] = [];
let createdIssues: Array<{ id: number; title: string; number: number; url: string }> = [];

// ─── MCP Server configs ──────────────────────────────────────────────────────
function getWorkIQMcpConfig(): Record<string, MCPLocalServerConfig | MCPRemoteServerConfig> {
    return {
        workiq: {
            type: "local",
            command: "npx",
            args: ["-y", "@microsoft/workiq", "mcp"],
            tools: ["*"],
            timeout: 180000,
        } as MCPLocalServerConfig,
    };
}

function getGitHubMcpConfig(): Record<string, MCPLocalServerConfig | MCPRemoteServerConfig> {
    return {
        github: {
            type: "http",
            url: "https://api.githubcopilot.com/mcp/",
            tools: ["*"],
        } as MCPRemoteServerConfig,
    };
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// Step 1: Extract meeting & analyze gaps (SSE for real-time streaming)
app.get("/api/analyze", async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const sendEvent = (event: string, data: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
        const analysis = await analyzeMeetingGaps(client, {
            workiqMcp: getWorkIQMcpConfig(),
            githubMcp: getGitHubMcpConfig(),
            onProgress: (step: number, message: string) => sendEvent("progress", { step, message }),
            onMeetingInfo: (info) => sendEvent("meeting-info", info),
            onRequirements: (requirements: string[]) => sendEvent("requirements", { requirements }),
            onGapStarted: (id: number) => sendEvent("gap-started", { id }),
            onGap: (gap) => sendEvent("gap", { gap }),
            onLog: (message: string) => sendEvent("log", { message }),
        });
        lastAnalysis = analysis;
        sendEvent("complete", { success: true, totalGaps: analysis.length });
    } catch (error) {
        console.error("Analysis error:", error);
        sendEvent("error", {
            success: false,
            error: error instanceof Error ? error.message : "Analysis failed",
        });
    } finally {
        res.end();
    }
});

// Step 2: Create GitHub issues for selected gaps (SSE streaming)
app.post("/api/create-issues", async (req, res) => {
    const { selectedIds } = req.body as { selectedIds: number[] };
    const selectedGaps = lastAnalysis.filter((g) => selectedIds.includes(g.id));

    if (selectedGaps.length === 0) {
        return res.status(400).json({ success: false, error: "No items selected" });
    }

    // Switch to SSE streaming
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const sendEvent = (event: string, data: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
        const issues = await createGithubIssues({
            gaps: selectedGaps,
            onProgress: (current, total, message) => sendEvent("progress", { current, total, message }),
            onIssueCreated: (issue) => sendEvent("issue", { issue }),
            onLog: (message) => sendEvent("log", { message }),
        });

        createdIssues = issues;
        sendEvent("complete", { success: true, total: issues.length });
    } catch (error) {
        console.error("Issue creation error:", error);
        sendEvent("error", {
            success: false,
            error: error instanceof Error ? error.message : "Issue creation failed",
        });
    } finally {
        res.end();
    }
});

// Step 3: Assign coding agent to issues (SSE streaming)
app.post("/api/assign-coding-agent", async (req, res) => {
    const { issueNumbers } = req.body as { issueNumbers: number[] };

    if (!issueNumbers?.length) {
        return res.status(400).json({ success: false, error: "No issues provided" });
    }

    // Switch to SSE streaming
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const sendEvent = (event: string, data: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
        const results = await assignCodingAgent({
            issueNumbers,
            onProgress: (current, total, message) => sendEvent("progress", { current, total, message }),
            onResult: (result) => sendEvent("result", { result }),
            onLog: (message) => sendEvent("log", { message }),
        });

        sendEvent("complete", { success: true, results });
    } catch (error) {
        console.error("Assign agent error:", error);
        sendEvent("error", {
            success: false,
            error: error instanceof Error ? error.message : "Agent assignment failed",
        });
    } finally {
        res.end();
    }
});

// Health check
app.get("/api/health", (_req, res) => {
    res.json({ status: "ok", state: client.getState() });
});

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🚀 Meeting-2-Code running at http://localhost:${PORT}\n`);
});
