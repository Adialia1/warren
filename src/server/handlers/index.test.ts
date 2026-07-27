import { describe, expect, test } from "bun:test";
import { isAuthExempt } from "./index.ts";

/* isAuthExempt tests (extracted from handlers.preview.test.ts, warren-599c / pl-9088 step 3). */

describe("isAuthExempt", () => {
	test("/healthz remains auth-exempt", () => {
		expect(isAuthExempt("/healthz")).toBe(true);
	});

	test("/version is auth-exempt (warren-6ea5)", () => {
		expect(isAuthExempt("/version")).toBe(true);
	});

	test("/runs/<id>/preview/login is gated (warren-e1b0 dropped the exemption)", () => {
		expect(isAuthExempt("/runs/run_abc/preview/login")).toBe(false);
		expect(isAuthExempt("/runs/run_abc/preview/login/")).toBe(false);
	});

	test("/metrics is gated (warren-682a — public-Ingress exposure)", () => {
		expect(isAuthExempt("/metrics")).toBe(false);
	});

	test("other /runs/* surfaces remain gated", () => {
		expect(isAuthExempt("/runs")).toBe(false);
		expect(isAuthExempt("/runs/run_abc")).toBe(false);
		expect(isAuthExempt("/runs/run_abc/events")).toBe(false);
		expect(isAuthExempt("/runs/run_abc/preview")).toBe(false);
		expect(isAuthExempt("/runs/run_abc/preview/login/extra")).toBe(false);
	});
});
