import { tailRunEvents } from "../../../runs/index.ts";
import { ndjsonResponse } from "../../response.ts";
import { reserveEventStreamSlot } from "../../stream-limits.ts";
import type { RouteHandler, ServerDeps } from "../../types.ts";
import { parseBoolean, parseNonNegativeInt, requireParam } from "../index.ts";

export function streamRunEventsHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		// 404 fast if the run isn't known — without this we'd happily
		// stream an empty NDJSON forever for a typo'd id.
		await deps.repos.runs.require(id);

		const follow = parseBoolean(ctx.url.searchParams.get("follow"), "follow") ?? false;
		const sinceSeq = parseNonNegativeInt(ctx.url.searchParams.get("since"), "since");

		const ctrl = bridgeAbort(ctx.request.signal);
		// Concurrency admission (warren-25f6) — AFTER the 404 so a typo'd id
		// never burns a slot, BEFORE any streaming work so a refusal is a fast
		// 503 + Retry-After rather than a connection warren has to hold.
		const slot = reserveEventStreamSlot({
			limiter: deps.streamLimiter,
			ctx,
			ctrl,
			route: "GET /runs/:id/events",
		});
		const source = tailRunEvents({
			runId: id,
			repos: { events: deps.repos.events },
			broker: deps.broker,
			follow,
			...(sinceSeq !== undefined ? { sinceSeq } : {}),
			signal: ctrl.signal,
		});
		return ndjsonResponse(
			asNdjsonStream(
				source,
				(row) => eventToNdjson(row),
				ctrl,
				() => slot.release(),
			),
		);
	};
}

/* ----------------------------------------------------------------------- */
/* Streaming plumbing                                                       */
/* ----------------------------------------------------------------------- */

export function bridgeAbort(reqSignal: AbortSignal): AbortController {
	const ctrl = new AbortController();
	if (reqSignal.aborted) {
		ctrl.abort();
		return ctrl;
	}
	reqSignal.addEventListener("abort", () => ctrl.abort(), { once: true });
	return ctrl;
}

/**
 * `onClose` (warren-25f6) fires exactly once the stream is no longer
 * attached — normal end-of-source, error, or client cancel. It carries the
 * event-stream slot release, so it runs BEFORE each exit's
 * `controller.close()` / `.error()`: those can themselves throw on a stream
 * the runtime already tore down, and a leaked slot would permanently shrink
 * the instance's capacity. `EventStreamSlot.release` is idempotent, so the
 * overlap between these paths is harmless.
 */
export function asNdjsonStream<T>(
	source: AsyncIterable<T>,
	encode: (value: T) => string,
	ctrl: AbortController,
	onClose?: () => void,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const iterator = source[Symbol.asyncIterator]();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await iterator.next();
				if (done) {
					onClose?.();
					controller.close();
					return;
				}
				controller.enqueue(encoder.encode(encode(value)));
			} catch (err) {
				onClose?.();
				if (ctrl.signal.aborted) {
					controller.close();
					return;
				}
				controller.error(err);
			}
		},
		async cancel() {
			onClose?.();
			ctrl.abort();
			try {
				await iterator.return?.(undefined);
			} catch {
				// ignore — generator's finally is the source of truth
			}
		},
	});
}

export function eventToNdjson(row: {
	id: number;
	runId: string;
	burrowEventSeq: number;
	ts: string;
	kind: string;
	stream: string | null;
	payloadJson: unknown;
}): string {
	return `${JSON.stringify({
		id: row.id,
		runId: row.runId,
		seq: row.burrowEventSeq,
		ts: row.ts,
		kind: row.kind,
		stream: row.stream,
		payload: row.payloadJson,
	})}\n`;
}
