/**
 * `POST /agents/refresh` `projectErrors[]` disclosure contract
 * (warren-bf4c / pl-b82d — same class as warren-4385).
 *
 * The all-projects loop catches whatever `refreshProjectAgents` threw and
 * used to forward `err.message` verbatim. That message is built by
 * `src/registry/canopy.ts`: `cn` stderr up to 500 chars, the project's
 * absolute `localPath`, and a git remote URL when the failure came from
 * the clone — i.e. the exact payload warren-4385 stopped `renderError`
 * from putting on the wire, arriving through a 200 body instead.
 *
 * These tests drive `collectProjectRefreshError` — the whole of the
 * catch block — rather than the route, because the library half of the
 * refresh clones through the module-local `defaultSpawn` and cannot be
 * stubbed from a test context. They assert against the SERIALIZED row,
 * which is what the caller actually receives, and against the log record,
 * which is where the withheld text has to survive.
 */

import { describe, expect, test } from "bun:test";
import { CanopyUnavailableError } from "../../registry/errors.ts";
import { collectedErrorMessage } from "../errors.ts";
import type { Logger, RouteContext } from "../types.ts";
import { collectProjectRefreshError } from "./agents.ts";

const REQUEST_ID = "req-bf4c-1";

/** A canopy shell-out failure phrased exactly as `parseEnvelope` phrases it. */
const LEAKY_STDERR =
	"cn list --type agent exited 128: fatal: could not read Username for 'https://x-access-token:ghp_0123456789abcdefghij@github.com/acme/private.git'";

function ctxWith(
	records: { obj: object; msg?: string }[],
): Pick<RouteContext, "logger" | "requestId"> {
	const logger: Logger = {
		info() {},
		warn() {},
		error(obj, msg) {
			records.push(msg !== undefined ? { obj, msg } : { obj });
		},
	};
	return { logger, requestId: REQUEST_ID };
}

describe("collectProjectRefreshError — body half (warren-bf4c)", () => {
	test("a canopy stderr message never reaches the wire row", () => {
		const err = new CanopyUnavailableError(LEAKY_STDERR, {
			recoveryHint: `ensure the cn binary is on PATH and the .canopy/ store exists at ${process.cwd()}`,
		});
		const row = collectProjectRefreshError("prj_acme", err, ctxWith([]));
		const body = JSON.stringify(row);
		expect(body).not.toContain("ghp_0123456789abcdefghij");
		expect(body).not.toContain("github.com/acme/private.git");
		expect(body).not.toContain("could not read Username");
		expect(body).not.toContain(process.cwd());
	});

	test("an untyped subprocess/filesystem error is withheld just the same", () => {
		const err = new Error("ENOENT: no such file or directory, open '/data/warren/projects/acme'");
		const row = collectProjectRefreshError("prj_acme", err, ctxWith([]));
		expect(row.message).not.toContain("/data/warren");
		expect(row.message).not.toContain("ENOENT");
	});

	test("the fixed message quotes the correlation id so the detail stays findable", () => {
		const row = collectProjectRefreshError("prj_acme", new Error(LEAKY_STDERR), ctxWith([]));
		expect(row.message).toBe(collectedErrorMessage(REQUEST_ID));
		expect(row.message).toContain(REQUEST_ID);
		expect(row.projectId).toBe("prj_acme");
	});

	test("a typed error keeps its machine code — that is the diagnosable part", () => {
		const row = collectProjectRefreshError(
			"prj_acme",
			new CanopyUnavailableError(LEAKY_STDERR),
			ctxWith([]),
		);
		expect(row.code).toBe("canopy_unavailable");
	});

	test("a prose-shaped `code` is dropped rather than forwarded", () => {
		// `code` is the one field still copied off the caught error, so an
		// error carrying a sentence there would reopen what `message` closed.
		const err = Object.assign(new Error("boom"), {
			code: "clone of https://github.com/acme/private.git failed",
		});
		const row = collectProjectRefreshError("prj_acme", err, ctxWith([]));
		expect(row.code).toBe("internal_error");
		expect(JSON.stringify(row)).not.toContain("github.com");
	});

	test("a non-Error thrown value produces the same row", () => {
		const row = collectProjectRefreshError("prj_acme", "/data/warren/projects/acme", ctxWith([]));
		expect(row.message).toBe(collectedErrorMessage(REQUEST_ID));
		expect(JSON.stringify(row)).not.toContain("/data/warren");
	});
});

describe("collectProjectRefreshError — log half (warren-bf4c)", () => {
	test("the real message and stack go to the request logger", () => {
		const records: { obj: object; msg?: string }[] = [];
		const err = new CanopyUnavailableError(LEAKY_STDERR);
		collectProjectRefreshError("prj_acme", err, ctxWith(records));

		expect(records).toHaveLength(1);
		const record = records[0];
		const fields = record?.obj as {
			err?: unknown;
			err_message?: string;
			err_stack?: string;
			projectId?: string;
		};
		expect(record?.msg).toBe("agents.refresh_project_tier_failed");
		expect(fields.err).toBe(err);
		expect(fields.err_message).toBe(LEAKY_STDERR);
		expect(typeof fields.err_stack).toBe("string");
		expect(fields.projectId).toBe("prj_acme");
	});
});
