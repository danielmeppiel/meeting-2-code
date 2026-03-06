// ─── Runtime configuration (env vars with defaults) ─────────────────────────

/** GitHub owner for the target repository */
export const OWNER = process.env.TARGET_OWNER || "danielmeppiel";

/** GitHub repository name */
export const REPO = process.env.TARGET_REPO || "corporate-website";

/** Full owner/repo slug */
export const REPO_SLUG = `${OWNER}/${REPO}`;

/** Local filesystem path to the target repository clone */
export const REPO_PATH =
    process.env.TARGET_REPO_PATH ||
    `/Users/${process.env.USER || "danielmeppiel"}/Repos/${REPO}`;

/** Remote clone URL */
export const REPO_URL = `https://github.com/${OWNER}/${REPO}.git`;

// ─── Per-request override ───────────────────────────────────────────────────

export interface RepoTarget {
    owner: string;
    repo: string;
    repoSlug: string;
    repoPath: string;
    repoUrl: string;
}

/**
 * Parse a "owner/repo" string from the frontend, falling back to env/default config.
 */
export function resolveRepo(targetRepo?: string): RepoTarget {
    let owner = OWNER;
    let repo = REPO;

    if (targetRepo && targetRepo.includes("/")) {
        const parts = targetRepo.split("/");
        owner = parts[0]!;
        repo = parts.slice(1).join("/");
    }

    return {
        owner,
        repo,
        repoSlug: `${owner}/${repo}`,
        repoPath: process.env.TARGET_REPO_PATH || `/Users/${process.env.USER || "danielmeppiel"}/Repos/${repo}`,
        repoUrl: `https://github.com/${owner}/${repo}.git`,
    };
}
