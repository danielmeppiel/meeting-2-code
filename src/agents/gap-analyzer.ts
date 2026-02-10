import type { CopilotClient, MCPLocalServerConfig, MCPRemoteServerConfig } from "@github/copilot-sdk";
import { createAgentSession } from "./session-helpers.js";

interface GapItem {
    id: number;
    requirement: string;
    currentState: string;
    gap: string;
    complexity: "Low" | "Medium" | "High" | "Critical";
    estimatedEffort: string;
    details: string;
}

interface AnalyzeMeetingOptions {
    workiqMcp: Record<string, MCPLocalServerConfig | MCPRemoteServerConfig>;
    githubMcp: Record<string, MCPLocalServerConfig | MCPRemoteServerConfig>;
    onProgress?: (step: number, message: string) => void;
    onRequirements?: (requirements: string[]) => void;
    onGap?: (gap: GapItem) => void;
    onLog?: (message: string) => void;
}

export async function analyzeMeetingGaps(
    client: CopilotClient,
    options: AnalyzeMeetingOptions,
): Promise<GapItem[]> {
    const progress = options.onProgress ?? (() => {});
    const onRequirements = options.onRequirements ?? (() => {});
    const onGap = options.onGap ?? (() => {});
    const log = options.onLog ?? (() => {});

    // ── Phase 1: Fetch the latest meeting using WorkIQ MCP ─────────────────
    progress(0, "Connecting to WorkIQ MCP Server...");
    log("Initializing WorkIQ MCP session (npx @microsoft/workiq mcp)...");
    console.log("[gap-analyzer] Creating WorkIQ MCP session...");

    let meetingContent = "";
    let requirements: string[] = [];
    try {
        const meetingSession = await createAgentSession(client, {
            model: "gpt-4.1",
            mcpServers: options.workiqMcp,
            systemMessage: {
                content: `You are a meeting analyst that retrieves meeting data from Microsoft 365 via WorkIQ.

CRITICAL RULES:
- You MUST use the WorkIQ meeting/calendar tools to search for and retrieve meetings from Microsoft 365.
- Do NOT use filesystem tools like glob, view, grep, or any file browsing tools.
- Do NOT read or search local files or directories.
- Your ONLY job is to call WorkIQ tools to find the meeting titled "Contoso Industries Redesign" and extract its content.

After retrieving the meeting notes/transcript, extract ALL actionable requirements.
Return the requirements as a JSON array of strings, each describing one specific requirement.
Only output the JSON array, nothing else.`,
            },
            label: "workiq-meeting",
            onLog: log,
        });

        progress(1, "Fetching meeting from WorkIQ...");
        log("Session created. Searching for meeting \"Contoso Industries Redesign\"...");
        console.log("[gap-analyzer] Sending WorkIQ query...");

        const meetingResult = await meetingSession.sendAndWait({
            prompt: `Use the WorkIQ meeting/calendar tools (NOT filesystem tools) to search for the latest meeting with the subject or title containing "Contoso Industries Redesign".
Retrieve the full meeting notes and/or transcript.
Then extract all actionable requirements, decisions, and action items.
Return them as a JSON array of requirement strings.

IMPORTANT: Do NOT use glob, view, grep, or any file-browsing tools. Only use WorkIQ/meeting tools.`,
        }, 300_000);
        meetingContent = meetingResult?.data?.content || "[]";
        console.log("[gap-analyzer] WorkIQ response:", meetingContent.substring(0, 500));
        log(`Agent response received (${meetingContent.length} chars)`);
        if (meetingContent.length > 5) {
            log(`Preview: ${meetingContent.substring(0, 150)}${meetingContent.length > 150 ? "..." : ""}`);
        }
        await meetingSession.destroy();

        // Parse requirements
        try {
            const jsonMatch = meetingContent.match(/\[[\s\S]*\]/);
            requirements = JSON.parse(jsonMatch?.[0] || "[]");
            if (!Array.isArray(requirements)) requirements = [];
            log(`Parsed JSON array → ${requirements.length} items`);
        } catch {
            // If not valid JSON, split by newlines as fallback
            log("Response wasn't valid JSON, parsing as text lines...");
            requirements = meetingContent
                .split("\n")
                .map((l: string) => l.replace(/^[\d\-.*]+\s*/, "").trim())
                .filter((l: string) => l.length > 10);
            log(`Extracted ${requirements.length} lines from text`);
        }
    } catch (err) {
        console.error("[gap-analyzer] WorkIQ MCP error:", err);
        log(`❌ WorkIQ MCP error: ${err instanceof Error ? err.message : String(err)}`);
        throw new Error(
            `Failed to connect to WorkIQ MCP Server: ${err instanceof Error ? err.message : String(err)}. ` +
            `Make sure 'npx -y @microsoft/workiq mcp' works and you have authenticated.`
        );
    }

    if (requirements.length === 0) {
        log(`❌ No requirements extracted. Raw response was: ${meetingContent.substring(0, 200)}`);
        throw new Error(
            `No requirements found in the meeting. The agent returned: "${meetingContent.substring(0, 100)}"\n` +
            `Make sure a meeting titled 'Contoso Industries Redesign' exists in your M365 calendar with notes or transcript.`
        );
    }

    // ── Stream requirements to frontend ────────────────────────────────────
    progress(2, `Extracted ${requirements.length} requirements from meeting`);
    log(`✔ ${requirements.length} requirements extracted successfully`);
    onRequirements(requirements);
    console.log(`[gap-analyzer] ${requirements.length} requirements extracted.`);

    // ── Phase 2: Analyze codebase gaps per requirement ─────────────────────
    progress(3, "Analyzing danielmeppiel/corporate-website...");
    log("Creating GitHub MCP session for codebase analysis...");
    console.log("[gap-analyzer] Creating codebase analysis session with GitHub MCP...");

    const codebaseSession = await createAgentSession(client, {
        model: "gpt-4.1",
        mcpServers: options.githubMcp,
        systemMessage: {
            content: `You are a senior software architect performing gap analysis on the repository "danielmeppiel/corporate-website".

You have access to GitHub MCP tools — USE THEM to browse the repository structure, read source files, 
and understand what currently exists in the codebase. Do NOT guess or assume what's in the repo.

For each requirement you are given, you MUST:
1. Browse the repo to find relevant files (check src/, frontend/, backend/, server/, etc.)
2. Read the actual code to understand what's implemented
3. Compare what exists against what the requirement asks for

For each requirement, provide:
- requirement: the requirement text  
- currentState: what ACTUALLY exists in the repo today (cite specific files/code)
- gap: what's missing or needs to change
- complexity: "Low", "Medium", "High", or "Critical"  
- estimatedEffort: time estimate (e.g., "2-4 hours", "1-2 days")
- details: specific implementation steps needed (files to create/modify, DB, API, frontend, tests)

IMPORTANT: Return ONLY a valid JSON array of objects. No markdown fences, no commentary. Just the raw JSON array.
Schema: [{"requirement":"string","currentState":"string","gap":"string","complexity":"Low|Medium|High|Critical","estimatedEffort":"string","details":"string"}]`,
        },
        label: "github-codebase",
        onLog: log,
    });

    progress(3, "Reading repo files and comparing against requirements...");
    log("Agent is browsing danielmeppiel/corporate-website via GitHub MCP...");
    log(`Comparing ${requirements.length} requirements against actual codebase...`);
    console.log("[gap-analyzer] Sending codebase analysis query with GitHub MCP...");

    const analysisResult = await codebaseSession.sendAndWait({
        prompt: `Here are the ${requirements.length} requirements extracted from the "Contoso Industries Redesign" meeting:

${JSON.stringify(requirements, null, 2)}

Use the GitHub MCP tools to browse the repository "danielmeppiel/corporate-website". 
Read the actual source files to understand what's implemented today.
Then for EACH requirement, analyze the gap between what exists and what's needed.
Be specific — reference actual file paths and code you find in the repo.
Return ONLY a valid JSON array.`,
    }, 300_000);
    const analysisContent = analysisResult?.data?.content || "[]";
    console.log("[gap-analyzer] Analysis response:", analysisContent.substring(0, 500));
    log(`Analysis response received (${analysisContent.length} chars)`);
    await codebaseSession.destroy();

    // ── Parse and stream gaps ──────────────────────────────────────────────
    progress(4, "Estimating complexity per task...");
    log("Parsing gap analysis results...");

    let gapItems: GapItem[] = [];
    try {
        const jsonMatch = analysisContent.match(/\[[\s\S]*\]/);
        const parsed = JSON.parse(jsonMatch?.[0] || "[]");
        gapItems = parsed.map((item: Omit<GapItem, "id">, index: number) => ({
            id: index + 1,
            requirement: item.requirement || requirements[index] || "Unknown requirement",
            currentState: item.currentState || "Not assessed",
            gap: item.gap || "Unknown",
            complexity: item.complexity || "Medium",
            estimatedEffort: item.estimatedEffort || "TBD",
            details: item.details || "No details available",
        }));
    } catch {
        console.error("[gap-analyzer] Failed to parse analysis:", analysisContent.substring(0, 500));
        // Create stub gaps from requirements
        gapItems = requirements.map((req, index) => ({
            id: index + 1,
            requirement: req,
            currentState: "Parse error — raw response logged to server console",
            gap: "Could not parse analysis",
            complexity: "Medium" as const,
            estimatedEffort: "TBD",
            details: analysisContent.substring(0, 300),
        }));
    }

    // Stream each gap to frontend one at a time  
    for (const gap of gapItems) {
        onGap(gap);
        log(`Gap #${gap.id}: ${gap.requirement.substring(0, 60)}... → ${gap.complexity}`);
    }

    log(`✔ Analysis complete: ${gapItems.length} gaps identified`);
    console.log(`[gap-analyzer] ${gapItems.length} gaps identified.`);
    return gapItems;
}
