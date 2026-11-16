import type { GenericAbortSignal } from "axios";
import PQueue from "p-queue";

/** Hands out evenly spaced turns to start requests, in call order. */
export class RequestPacer {
	private readonly queue: PQueue;
	private pausedUntil = 0;
	private resumeTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(requestsPerMinute: number) {
		if (!(Number.isFinite(requestsPerMinute) && requestsPerMinute > 0)) {
			throw new RangeError(
				`rateLimit.requestsPerMinute must be a positive number, got ${requestsPerMinute}`,
			);
		}

		this.queue = new PQueue({
			intervalCap: 1,
			interval: 60_000 / requestsPerMinute,
			strict: true,
		});
	}

	/** On abort, leaves the queue and resolves so axios cancels the request unsent. */
	async waitForTurn(signal?: GenericAbortSignal) {
		try {
			await this.queue.add(() => {}, {
				signal: signal instanceof AbortSignal ? signal : undefined,
			});
		} catch (error) {
			if (!signal?.aborted) {
				throw error;
			}
		}
	}

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
