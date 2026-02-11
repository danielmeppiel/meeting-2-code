import { exec } from "child_process";
import { promisify } from "util";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import type { CopilotClient, MCPLocalServerConfig, MCPRemoteServerConfig } from "@github/copilot-sdk";
import { createAgentSession } from "./session-helpers.js";

const execAsync = promisify(exec);

const OWNER = "danielmeppiel";
const REPO = "corporate-website";
const REPO_URL = `https://github.com/${OWNER}/${REPO}.git`;
const REPO_PATH = `/Users/${process.env.USER || "danielmeppiel"}/Repos/${REPO}`;

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

// ── Clone helpers ─────────────────────────────────────────────────────────────

/** Ensure the corporate-website repo is cloned locally and up-to-date. */
async function ensureClone(log: (m: string) => void): Promise<void> {
    if (!existsSync(join(REPO_PATH, ".git"))) {
        log(`Cloning ${OWNER}/${REPO} to ${REPO_PATH}...`);
        await execAsync(`git clone ${REPO_URL} "${REPO_PATH}"`, { timeout: 120_000 });
    }
    await execAsync("git fetch origin", { cwd: REPO_PATH, timeout: 30_000 });
    await execAsync("git checkout main --force", { cwd: REPO_PATH, timeout: 10_000 });
    await execAsync("git reset --hard origin/main", { cwd: REPO_PATH, timeout: 10_000 });
    await execAsync("git clean -fd", { cwd: REPO_PATH, timeout: 10_000 });
    log("Local clone of corporate-website is up-to-date on main.");
}

/** Create a feature branch in the local clone. */
async function createLocalBranch(branchName: string, log: (m: string) => void): Promise<void> {
    await execAsync(`git checkout -b ${branchName}`, { cwd: REPO_PATH, timeout: 10_000 });
    log(`Created local branch: ${branchName}`);
}

/** Commit all changes and push the branch to origin. */
async function commitAndPush(branchName: string, message: string, log: (m: string) => void): Promise<void> {
    await execAsync("git add -A", { cwd: REPO_PATH, timeout: 10_000 });
    // Check if there are staged changes
    const { stdout: status } = await execAsync("git status --porcelain", { cwd: REPO_PATH, timeout: 10_000 });
    if (!status.trim()) {
        log("No changes to commit.");
        return;
    }
    const safeMsg = message.replace(/"/g, '\\"').replace(/\n/g, " ");
    await execAsync(`git commit -m "${safeMsg}"`, { cwd: REPO_PATH, timeout: 10_000 });
    await execAsync(`git push origin ${branchName} --force`, { cwd: REPO_PATH, timeout: 60_000 });
    log(`Pushed branch ${branchName} to origin.`);
}

/** Read key website files from the local clone to give the model context. */
function readWebsiteFiles(basePath: string): { path: string; content: string }[] {
    const files: { path: string; content: string }[] = [];
    const extensions = [".html", ".css", ".js", ".ts", ".tsx", ".jsx", ".json", ".md"];
    const ignoreDirs = ["node_modules", ".git", ".azure", "dist", ".apm"];

    function walk(dir: string, depth = 0) {
        if (depth > 3) return; // limit depth
        let entries: string[];
        try { entries = readdirSync(dir); } catch { return; }
        for (const entry of entries) {
            if (ignoreDirs.includes(entry)) continue;
            const fullPath = join(dir, entry);
            let stats;
            try { stats = statSync(fullPath); } catch { continue; }
            if (stats.isDirectory()) {
                walk(fullPath, depth + 1);
            } else if (extensions.some(ext => entry.endsWith(ext)) && stats.size < 100_000) {
                try {
                    const content = readFileSync(fullPath, "utf-8");
                    files.push({ path: relative(basePath, fullPath), content });
                } catch { /* skip unreadable */ }
            }
        }
    }
    walk(basePath);
    return files;
}

/** Parse file changes from the model response. Expects fenced code blocks with FILE: headers. */
function parseFileChanges(response: string): { file: string; content: string }[] {
    const changes: { file: string; content: string }[] = [];
    // Match patterns like:
    //   FILE: path/to/file.html
    //   ```html
    //   <content>
    //   ```
    // OR: ```html:path/to/file.html
    const blockRegex = /(?:FILE:\s*(.+?)\s*\n```[a-z]*\n([\s\S]*?)```)|(?:```[a-z]*:(.+?)\s*\n([\s\S]*?)```)/g;
    let match;
    while ((match = blockRegex.exec(response)) !== null) {
        const file = (match[1] || match[3] || "").trim();
        const content = (match[2] || match[4] || "").trim();
        if (file && content) {
            changes.push({ file, content });
        }
    }
    return changes;
}

// ── Main agent logic ──────────────────────────────────────────────────────────

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

    // Ensure corporate-website is cloned and clean before starting
    onProgress(options.gaps[0]?.id ?? 0, "Preparing local clone of corporate-website...");
    await ensureClone(log);

    for (let i = 0; i < options.gaps.length; i++) {
        const gap = options.gaps[i]!;
        log(`\n── Gap ${i + 1}/${options.gaps.length}: ${gap.requirement.substring(0, 80)} ──`);
        onStart(gap.id, gap.requirement);

        const branchName = `feature/gap-${gap.id}-${gap.requirement.substring(0, 30).replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`;

        try {
            // Reset to main before each gap so branches are independent
            await execAsync("git checkout main --force", { cwd: REPO_PATH, timeout: 10_000 });
            await execAsync("git reset --hard origin/main", { cwd: REPO_PATH, timeout: 10_000 });

            // Create feature branch in the LOCAL clone
            onProgress(gap.id, `Creating branch ${branchName} in local clone...`);
            await createLocalBranch(branchName, log);

            // Read the website files from the local clone for context
            onProgress(gap.id, "Reading website files from local clone...");
            const websiteFiles = readWebsiteFiles(REPO_PATH);
            log(`Read ${websiteFiles.length} files from local clone.`);

            // Build file context string (limit to ~50KB to fit in context)
            let fileContext = "";
            let totalSize = 0;
            for (const f of websiteFiles) {
                const block = `\n--- FILE: ${f.path} ---\n${f.content}\n`;
                if (totalSize + block.length > 50_000) break;
                fileContext += block;
                totalSize += block.length;
            }

            // Create Copilot SDK session — GitHub MCP is provided for reading
            // but the system prompt constrains the agent to OUTPUT changes only
            onProgress(gap.id, "Creating agent session...");
            log("Creating Copilot SDK session for local implementation...");

            const session = await createAgentSession(client, {
                model: "claude-sonnet-4-20250514",
                mcpServers: options.githubMcp,
                systemMessage: {
                    content: `You are a coding agent that implements features in the ${OWNER}/${REPO} repository.

CRITICAL RULES:
- You may use GitHub MCP tools ONLY to READ files from owner="${OWNER}" repo="${REPO}".
- Do NOT use MCP tools to create branches, create/update files, or make commits.
  The branch has already been created locally. File writes and commits are handled externally.
- Do NOT operate on any other repository. The ONLY repo is ${OWNER}/${REPO}.

Your job: analyze the requirement, read any additional files you need via MCP (owner="${OWNER}", repo="${REPO}"),
then output the COMPLETE updated content of every file that needs to change.

OUTPUT FORMAT — for each file you change, output:
FILE: <relative-path>
\`\`\`<language>
<full updated file content>
\`\`\`

Include the FULL file content, not diffs or partial snippets.
Only output files that actually need changes.`,
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
Implement the following requirement in the ${OWNER}/${REPO} repository.

**Requirement:** ${gap.requirement}

**Current Gap:** ${gap.gap}

**Implementation Details:** ${gap.details}

**Complexity:** ${gap.complexity}

Here are the current files in the repository for context:
${fileContext}

Please analyze the requirement, read any additional files you need using GitHub MCP
(always use owner="${OWNER}" and repo="${REPO}"), then output the complete updated content
of every file that needs to change using the FILE: format described in your instructions.`;

            const response = await session.sendAndWait({ prompt }, 300_000);
            const responseContent = response?.data?.content ?? "";
            await session.destroy();

            // Parse the file changes from the model's response
            onProgress(gap.id, "Applying changes to local clone...");
            const changes = parseFileChanges(responseContent);

            if (changes.length === 0) {
                log("⚠ No parseable file changes in agent response. Attempting raw summary.");
                const summary = responseContent.substring(0, 500) || "Agent responded but no file changes were parsed.";
                onComplete(gap.id, true, summary);
                results.push({ id: gap.id, success: true, summary });
                continue;
            }

            // Write each changed file to the local clone
            for (const change of changes) {
                const filePath = join(REPO_PATH, change.file);
                log(`Writing: ${change.file}`);
                writeFileSync(filePath, change.content + "\n", "utf-8");
            }

            // Commit and push from the local clone
            onProgress(gap.id, "Committing and pushing changes...");
            const commitMsg = `Implement gap #${gap.id}: ${gap.requirement.substring(0, 60)}`;
            await commitAndPush(branchName, commitMsg, log);

            const summary = `Applied ${changes.length} file change(s) to branch ${branchName}: ${changes.map(c => c.file).join(", ")}`;
            log(`✔ Gap #${gap.id} completed successfully`);
            onComplete(gap.id, true, summary);
            results.push({ id: gap.id, success: true, summary });
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.error(`[local-agent] Error on gap #${gap.id}:`, errorMsg);
            log(`✘ Gap #${gap.id} failed: ${errorMsg.substring(0, 200)}`);
            onComplete(gap.id, false, errorMsg.substring(0, 300));
            results.push({ id: gap.id, success: false, summary: errorMsg.substring(0, 300) });
            // Try to get back to main for the next gap
            try { await execAsync("git checkout main --force", { cwd: REPO_PATH, timeout: 10_000 }); } catch { /* ignore */ }
        }
    }

    const successCount = results.filter(r => r.success).length;
    log(`\n✔ Local agent done — ${successCount}/${results.length} gaps completed successfully`);
    return results;
}
