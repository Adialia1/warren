/**
 * Public-instance org allowlist (warren-ce9b / pl-b82d step 17).
 *
 * `WARREN_AUTH=public` admits credential-less spectators to the public
 * projection of every project on the instance (`src/server/auth.ts`). The
 * redaction work that precedes it (warren-946f / 4f6c / 1cb7) is a field
 * allowlist per response; this module is the STRUCTURAL half — if the only
 * repos that can ever be registered are public ones, a redaction miss
 * discloses already-public content instead of a private repo's source,
 * prompts, or transcripts.
 *
 * `WARREN_PUBLIC_ORG_ALLOWLIST` is a comma-separated list of GitHub
 * owners, consulted ONLY under `WARREN_AUTH=public` (token mode is
 * entirely unaffected — `resolvePublicOrgAllowlist` returns `undefined`
 * and every assertion below is a no-op). Two enforcement points:
 *
 *   - **boot** (`bootServer`) — the list is parsed before the db opens,
 *     then every already-registered project is held to it. A project
 *     outside the allowlist refuses the boot, naming the offenders, rather
 *     than serving them anonymously for however long nobody notices.
 *   - **registration** (`POST /projects`) — a non-allowlisted org is a
 *     `ValidationError` → HTTP 400, raised before `addProject` so nothing
 *     is cloned.
 *
 * Fail closed, three ways: public mode with an absent or empty allowlist
 * refuses the boot (an empty list is a misconfiguration, never "allow
 * everything"); a db row whose `gitUrl` no longer parses counts as NOT
 * allowlisted; and the selector that reaches here can never resolve to
 * `public` by accident (see `resolveAuthKind`).
 *
 * Owner comparison is case-insensitive (GitHub owners are), matched
 * against the `owner` `parseGitHubUrl` extracts — so the allowlist is
 * checked against the same string the on-disk layout uses, not against
 * raw URL text a caller controls.
 *
 * **Tradeoff taken (deliberate):** this gate proves the *org*, not that
 * the *repo* is public. An allowlisted org can still hold private repos,
 * and asserting otherwise means a forge API call per registration — a
 * network dependency on `POST /projects` (and on boot, for the
 * already-registered sweep) that can fail, rate-limit, or need
 * credentials warren does not otherwise require to add a public repo. The
 * offline org check was chosen instead: it is deterministic, it cannot
 * wedge a boot on a GitHub outage, and it keeps the operator's
 * responsibility legible — put an org on the list only when every repo in
 * it is one you are happy to publish. Per-repo visibility via the forge is
 * left to whoever needs a stricter posture than that.
 */

import { ValidationError, WarrenError } from "../core/errors.ts";
import { parseGitHubUrl } from "../projects/url.ts";
import type { AuthKind } from "./auth.ts";

export const WARREN_PUBLIC_ORG_ALLOWLIST_ENV = "WARREN_PUBLIC_ORG_ALLOWLIST" as const;

export type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * The GitHub owners a public instance may hold, lowercased. A `ReadonlySet`
 * rather than an array so the membership test can't drift into a substring
 * match somewhere down the line.
 */
export type PublicOrgAllowlist = ReadonlySet<string>;

/** Same character set `parseGitHubUrl` validates an owner against. */
const OWNER = /^[A-Za-z0-9._-]+$/;

/**
 * Public mode is misconfigured, or an already-registered project falls
 * outside the allowlist. Only ever thrown at boot — there is no HTTP
 * status for it because the process refuses to start.
 */
export class PublicOrgAllowlistError extends WarrenError {
	readonly code = "public_org_allowlist_invalid";
}

/**
 * Parse `WARREN_PUBLIC_ORG_ALLOWLIST`. Absent, blank, or all-empty-entries
 * throws — public mode with no allowlist is the misconfiguration this whole
 * module exists to refuse, so it must never mean "allow everything".
 */
export function loadPublicOrgAllowlistFromEnv(env: EnvLike = process.env): PublicOrgAllowlist {
	const raw = env[WARREN_PUBLIC_ORG_ALLOWLIST_ENV] ?? "";
	const owners = raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
	if (owners.length === 0) {
		throw new PublicOrgAllowlistError(
			`WARREN_AUTH=public requires a non-empty ${WARREN_PUBLIC_ORG_ALLOWLIST_ENV}`,
			{
				recoveryHint: `export ${WARREN_PUBLIC_ORG_ALLOWLIST_ENV}=<org>[,<org>...] — the GitHub owners whose repos this public instance may hold`,
			},
		);
	}
	for (const owner of owners) {
		if (!OWNER.test(owner) || owner.startsWith("-")) {
			throw new PublicOrgAllowlistError(
				`${WARREN_PUBLIC_ORG_ALLOWLIST_ENV} entry is not a GitHub owner: ${JSON.stringify(owner)}`,
				{ recoveryHint: "list bare owners (e.g. jayminwest,os-eco), not URLs or owner/name pairs" },
			);
		}
	}
	return new Set(owners.map((owner) => owner.toLowerCase()));
}

/**
 * The allowlist this process enforces, or `undefined` when it enforces
 * none. Called once at boot: `public` parses the env (throwing on a
 * missing/empty list), every other backend opts out entirely.
 */
export function resolvePublicOrgAllowlist(
	kind: AuthKind,
	env: EnvLike = process.env,
): PublicOrgAllowlist | undefined {
	return kind === "public" ? loadPublicOrgAllowlistFromEnv(env) : undefined;
}

/** Is `owner` on the list? Case-insensitive, exact match on the whole owner. */
export function isOrgAllowlisted(allowlist: PublicOrgAllowlist, owner: string): boolean {
	return allowlist.has(owner.trim().toLowerCase());
}

/**
 * Would `gitUrl` be allowed? A url that doesn't parse is NOT allowed —
 * a tampered or legacy db row must not slip through on a parse failure.
 */
function isGitUrlAllowlisted(allowlist: PublicOrgAllowlist, gitUrl: string): boolean {
	try {
		return isOrgAllowlisted(allowlist, parseGitHubUrl(gitUrl).owner);
	} catch {
		return false;
	}
}

/**
 * Registration gate for `POST /projects`. `allowlist === undefined` (token
 * mode) is a no-op, so the fresh-install path is untouched. Throws
 * `ValidationError` → HTTP 400; call it BEFORE `addProject` so a refused
 * org never reaches `git clone`.
 */
export function assertGitUrlAllowlisted(
	allowlist: PublicOrgAllowlist | undefined,
	gitUrl: string,
): void {
	if (allowlist === undefined) return;
	// Parse outside the try/catch of `isGitUrlAllowlisted`: an unparseable
	// url here is the caller's own bad input and deserves its own message.
	const { owner } = parseGitHubUrl(gitUrl);
	if (isOrgAllowlisted(allowlist, owner)) return;
	throw new ValidationError(`org "${owner}" is not on this public instance's org allowlist`, {
		recoveryHint: `this instance may only hold repos from: ${formatAllowlist(allowlist)} — add the org to ${WARREN_PUBLIC_ORG_ALLOWLIST_ENV} and restart, or register the repo on a token-mode instance`,
	});
}

/** The subset of a project row this module needs — the whole `ProjectRow` is overkill. */
export interface RegisteredProjectOrigin {
	readonly id: string;
	readonly gitUrl: string;
}

/**
 * Boot gate. Refuses to start when any already-registered project falls
 * outside the allowlist, naming every offender so the operator can delete
 * or re-scope them in one pass instead of one restart per project.
 * `allowlist === undefined` (token mode) is a no-op.
 */
export function assertRegisteredProjectsAllowlisted(
	allowlist: PublicOrgAllowlist | undefined,
	projects: readonly RegisteredProjectOrigin[],
): void {
	if (allowlist === undefined) return;
	const offending = projects.filter((project) => !isGitUrlAllowlisted(allowlist, project.gitUrl));
	if (offending.length === 0) return;
	const named = offending.map((project) => `${project.id} (${project.gitUrl})`).join(", ");
	throw new PublicOrgAllowlistError(
		`WARREN_AUTH=public but ${offending.length} registered project(s) fall outside ${WARREN_PUBLIC_ORG_ALLOWLIST_ENV}: ${named}`,
		{
			recoveryHint: `allowlisted orgs: ${formatAllowlist(allowlist)} — DELETE /projects/:id for each offender, or widen ${WARREN_PUBLIC_ORG_ALLOWLIST_ENV}, then restart`,
		},
	);
}

function formatAllowlist(allowlist: PublicOrgAllowlist): string {
	return [...allowlist].sort().join(", ");
}
