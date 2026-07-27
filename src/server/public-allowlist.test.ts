/**
 * Public-instance org allowlist (warren-ce9b / pl-b82d step 17).
 *
 * The gate is only worth anything if it fails CLOSED, so that is what most
 * of this file pins: public mode with no allowlist refuses, an unparseable
 * `gitUrl` counts as not-allowlisted, and token mode is untouched in every
 * direction. The over-the-wire half (`POST /projects` → 400, nothing
 * cloned) lives in `handlers/projects.public-allowlist.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import {
	assertGitUrlAllowlisted,
	assertRegisteredProjectsAllowlisted,
	WARREN_PUBLIC_ORG_ALLOWLIST_ENV as ENV,
	isOrgAllowlisted,
	loadPublicOrgAllowlistFromEnv,
	type PublicOrgAllowlist,
	PublicOrgAllowlistError,
	resolvePublicOrgAllowlist,
} from "./public-allowlist.ts";

const ALLOWED: PublicOrgAllowlist = new Set(["os-eco", "jayminwest"]);

describe("loadPublicOrgAllowlistFromEnv", () => {
	test("parses a comma-separated list, trimming and lowercasing", () => {
		const allowlist = loadPublicOrgAllowlistFromEnv({ [ENV]: " os-eco , JayminWest " });
		expect([...allowlist].sort()).toEqual(["jayminwest", "os-eco"]);
	});

	test("a single owner is a valid list", () => {
		expect([...loadPublicOrgAllowlistFromEnv({ [ENV]: "os-eco" })]).toEqual(["os-eco"]);
	});

	// The fail-closed core: an absent or empty list must never widen to
	// "every org". Reverting the length check makes all four of these pass.
	test("absent, blank, or all-empty-entry values refuse", () => {
		for (const raw of [undefined, "", "   ", ",", " , , "]) {
			expect(() => loadPublicOrgAllowlistFromEnv(raw === undefined ? {} : { [ENV]: raw })).toThrow(
				PublicOrgAllowlistError,
			);
		}
	});

	test("entries that aren't bare owners refuse", () => {
		for (const raw of [
			"https://github.com/os-eco",
			"os-eco/warren",
			"os eco",
			"-os-eco",
			"os:eco",
			"*",
		]) {
			expect(() => loadPublicOrgAllowlistFromEnv({ [ENV]: raw })).toThrow(/is not a GitHub owner/);
		}
	});

	test("the refusal names the env var so the operator knows what to set", () => {
		expect(() => loadPublicOrgAllowlistFromEnv({})).toThrow(ENV);
	});
});

describe("resolvePublicOrgAllowlist", () => {
	test("token mode opts out entirely — a bad allowlist isn't even parsed", () => {
		expect(resolvePublicOrgAllowlist("token", {})).toBeUndefined();
		expect(resolvePublicOrgAllowlist("token", { [ENV]: "os-eco/warren" })).toBeUndefined();
	});

	test("public mode parses the list", () => {
		const allowlist = resolvePublicOrgAllowlist("public", { [ENV]: "os-eco" });
		expect(allowlist).toBeDefined();
		expect(allowlist?.has("os-eco")).toBe(true);
	});

	test("public mode with no allowlist refuses the boot", () => {
		expect(() => resolvePublicOrgAllowlist("public", {})).toThrow(PublicOrgAllowlistError);
	});
});

describe("isOrgAllowlisted", () => {
	test("matches case-insensitively on the whole owner", () => {
		expect(isOrgAllowlisted(ALLOWED, "os-eco")).toBe(true);
		expect(isOrgAllowlisted(ALLOWED, "OS-ECO")).toBe(true);
		expect(isOrgAllowlisted(ALLOWED, " os-eco ")).toBe(true);
	});

	test("no substring or prefix match", () => {
		expect(isOrgAllowlisted(ALLOWED, "os")).toBe(false);
		expect(isOrgAllowlisted(ALLOWED, "os-eco-evil")).toBe(false);
		expect(isOrgAllowlisted(ALLOWED, "evil-os-eco")).toBe(false);
	});
});

describe("assertGitUrlAllowlisted", () => {
	test("token mode (undefined allowlist) is a no-op", () => {
		expect(() =>
			assertGitUrlAllowlisted(undefined, "https://github.com/somebody/private"),
		).not.toThrow();
	});

	test("accepts every URL shape parseGitHubUrl accepts", () => {
		for (const url of [
			"https://github.com/os-eco/warren",
			"https://github.com/os-eco/warren.git",
			"git@github.com:os-eco/warren.git",
			"ssh://git@github.com/OS-ECO/warren",
		]) {
			expect(() => assertGitUrlAllowlisted(ALLOWED, url)).not.toThrow();
		}
	});

	test("a non-allowlisted org is a ValidationError (HTTP 400) naming the org", () => {
		expect(() => assertGitUrlAllowlisted(ALLOWED, "https://github.com/somebody/private")).toThrow(
			ValidationError,
		);
		expect(() => assertGitUrlAllowlisted(ALLOWED, "https://github.com/somebody/private")).toThrow(
			/"somebody" is not on this public instance's org allowlist/,
		);
	});

	test("an unparseable url still rejects (parseGitHubUrl's own message)", () => {
		expect(() => assertGitUrlAllowlisted(ALLOWED, "not-a-url")).toThrow(ValidationError);
	});
});

describe("assertRegisteredProjectsAllowlisted", () => {
	test("token mode (undefined allowlist) is a no-op", () => {
		expect(() =>
			assertRegisteredProjectsAllowlisted(undefined, [
				{ id: "p1", gitUrl: "https://github.com/somebody/private" },
			]),
		).not.toThrow();
	});

	test("an empty instance and an all-allowlisted instance both boot", () => {
		expect(() => assertRegisteredProjectsAllowlisted(ALLOWED, [])).not.toThrow();
		expect(() =>
			assertRegisteredProjectsAllowlisted(ALLOWED, [
				{ id: "p1", gitUrl: "https://github.com/os-eco/warren.git" },
				{ id: "p2", gitUrl: "git@github.com:jayminwest/burrow.git" },
			]),
		).not.toThrow();
	});

	test("one offender refuses the boot, naming its id and url", () => {
		expect(() =>
			assertRegisteredProjectsAllowlisted(ALLOWED, [
				{ id: "p1", gitUrl: "https://github.com/os-eco/warren.git" },
				{ id: "p2", gitUrl: "https://github.com/somebody/private.git" },
			]),
		).toThrow(PublicOrgAllowlistError);
		expect(() =>
			assertRegisteredProjectsAllowlisted(ALLOWED, [
				{ id: "p2", gitUrl: "https://github.com/somebody/private.git" },
			]),
		).toThrow(/p2 \(https:\/\/github.com\/somebody\/private.git\)/);
	});

	test("every offender is named in one message, not just the first", () => {
		let message = "";
		try {
			assertRegisteredProjectsAllowlisted(ALLOWED, [
				{ id: "p1", gitUrl: "https://github.com/somebody/private.git" },
				{ id: "p2", gitUrl: "https://github.com/os-eco/warren.git" },
				{ id: "p3", gitUrl: "https://github.com/elsewhere/other.git" },
			]);
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).toContain("2 registered project(s)");
		expect(message).toContain("p1");
		expect(message).toContain("p3");
		expect(message).not.toContain("p2");
	});

	// A tampered or legacy row must not slip through on a parse failure.
	test("an unparseable stored gitUrl counts as NOT allowlisted", () => {
		expect(() =>
			assertRegisteredProjectsAllowlisted(ALLOWED, [{ id: "p9", gitUrl: "file:///etc/passwd" }]),
		).toThrow(PublicOrgAllowlistError);
	});
});
