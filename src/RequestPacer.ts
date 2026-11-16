import type { GenericAbortSignal } from "axios";
import PQueue from "p-queue";

/**
 * Hands out turns to start requests, one at a time and evenly spaced, in the order they were asked for.
 *
 * A p-queue with one start per `60_000 / requestsPerMinute` ms does the spacing. Its sliding window (`strict`) means
 * no two starts are ever closer than that, even across window boundaries. A 429 pauses the queue, which holds back
 * requests that are already waiting as well as new ones.
 */
export class RequestPacer {
	readonly intervalMs: number;
	private readonly queue: PQueue;
	private pausedUntil = 0;
	private resumeTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(requestsPerMinute: number) {
		if (!(Number.isFinite(requestsPerMinute) && requestsPerMinute > 0)) {
			throw new RangeError(
				`rateLimit.requestsPerMinute must be a positive number, got ${requestsPerMinute}`,
			);
		}

		this.intervalMs = 60_000 / requestsPerMinute;
		this.queue = new PQueue({
			intervalCap: 1,
			interval: this.intervalMs,
			strict: true,
		});
	}

	/**
	 * Resolves when the caller may start its request. If `signal` aborts while waiting, the caller leaves the queue
	 * without taking a turn, and this resolves so that axios cancels the request before sending it.
	 */
	async waitForTurn(signal?: GenericAbortSignal) {
		try {
			await this.queue.add(() => {}, {
				// p-queue needs a real AbortSignal to listen to
				signal: signal instanceof AbortSignal ? signal : undefined,
			});
		} catch (error) {
			if (!signal?.aborted) {
				throw error;
			}
		}
	}

	/** Holds back every turn, including those already waiting, until `ms` from now. */
	pauseFor(ms: number) {
		const until = Date.now() + ms;
		if (until <= this.pausedUntil) {
			return;
		}

		this.pausedUntil = until;
		this.queue.pause();
		clearTimeout(this.resumeTimer);
		this.resumeTimer = setTimeout(() => this.queue.start(), ms);
	}
}
