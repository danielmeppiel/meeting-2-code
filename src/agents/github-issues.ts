import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const OWNER = "danielmeppiel";
const REPO = "corporate-website";

interface GapItem {
    id: number;
    requirement: string;
    currentState: string;
    gap: string;
    complexity: "Low" | "Medium" | "High" | "Critical";
    estimatedEffort: string;
    details: string;
}

interface CreatedIssue {
    id: number;
    title: string;
    number: number;
    url: string;
    error?: string;
}

interface CreateIssuesOptions {
    gaps: GapItem[];
    onProgress?: (current: number, total: number, message: string) => void;
    onIssueCreated?: (issue: CreatedIssue) => void;
    onLog?: (message: string) => void;
}

export async function createGithubIssues(
    options: CreateIssuesOptions,
): Promise<CreatedIssue[]> {
    const progress = options.onProgress ?? (() => {});
    const onIssueCreated = options.onIssueCreated ?? (() => {});
    const log = options.onLog ?? (() => {});
    const total = options.gaps.length;

    progress(0, total, "Connecting to GitHub...");
    log("Creating GitHub issues via gh CLI...");
    console.log(`[github-issues] Creating ${total} issues via gh CLI...`);

    const createdIssues: CreatedIssue[] = [];

    for (let i = 0; i < options.gaps.length; i++) {
        const gap = options.gaps[i]!;
        const label = gap.requirement.length > 50 ? gap.requirement.substring(0, 50) + "..." : gap.requirement;
        progress(i + 1, total, `Creating issue ${i + 1}/${total}: ${label}`);
        log(`Creating issue ${i + 1}/${total}: ${label}`);
        console.log(`[github-issues] Creating issue ${i + 1}/${total}...`);

        const title = `[Contoso Redesign] ${gap.requirement}`;
        const body = [
            "## Description",
            gap.gap,
            "",
            "## Current State",
            gap.currentState,
            "",
            "## Acceptance Criteria",
            "- The gap described above is fully addressed",
            "",
            "## Technical Details",
            gap.details,
            "",
            "## Estimated Effort",
            `${gap.estimatedEffort} | Complexity: ${gap.complexity}`,
        ].join("\n");

        try {
            // Use gh issue create with --json to get structured output
            const { stdout, stderr } = await execAsync(
                `gh issue create --title ${shellEscape(title)} --body ${shellEscape(body)} --label enhancement -R ${OWNER}/${REPO}`,
                { timeout: 30_000, env: { ...process.env, GITHUB_TOKEN: undefined, GH_PAGER: "cat" } },
            );

            if (stderr) console.log(`[github-issues] stderr for issue ${i + 1}:`, stderr.trim());

            // gh issue create outputs a URL like: https://github.com/owner/repo/issues/123
            const url = stdout.trim();
            const numberMatch = url.match(/\/issues\/(\d+)/);
            const issueNumber = numberMatch ? parseInt(numberMatch[1]!, 10) : 0;

            if (issueNumber > 0) {
                const issue: CreatedIssue = {
                    id: i + 1,
                    title,
                    number: issueNumber,
                    url,
                };
                createdIssues.push(issue);
                onIssueCreated(issue);
                log(`✔ Issue #${issueNumber} created: ${title.substring(0, 60)}`);
                console.log(`[github-issues] Issue ${i + 1} created: #${issueNumber} → ${url}`);
            } else {
                console.error(`[github-issues] Unexpected gh output for issue ${i + 1}:`, stdout);
                log(`⚠ Issue ${i + 1}: unexpected output — ${stdout.substring(0, 100)}`);
                const issue: CreatedIssue = {
                    id: i + 1,
                    title,
                    number: 0,
                    url: "#",
                    error: `Unexpected CLI output: ${stdout.substring(0, 100)}`,
                };
                createdIssues.push(issue);
                onIssueCreated(issue);
            }
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            console.error(`[github-issues] Error creating issue ${i + 1}:`, errorMsg);
            log(`✘ Error creating issue ${i + 1}: ${errorMsg.substring(0, 150)}`);
            const issue: CreatedIssue = {
                id: i + 1,
                title,
                number: 0,
                url: "#",
                error: errorMsg.substring(0, 200),
            };
            createdIssues.push(issue);
            onIssueCreated(issue);
        }
    }

    const successCount = createdIssues.filter(i => i.number > 0).length;
    const failCount = total - successCount;
    if (failCount > 0) {
        log(`⚠ Done — ${successCount}/${total} issues created, ${failCount} failed`);
    } else {
        log(`✔ Done — ${successCount} issues created successfully`);
    }
    console.log(`[github-issues] Done. ${successCount}/${total} issues created.`);
    return createdIssues;
}

/** Shell-escape a string for use in a command argument */
function shellEscape(str: string): string {
    // Replace single quotes, then wrap in single quotes
    return "'" + str.replace(/'/g, "'\\''") + "'";
}
