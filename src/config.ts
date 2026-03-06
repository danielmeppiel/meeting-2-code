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
