import type {
	AxiosError,
	AxiosInstance,
	AxiosRequestConfig,
	AxiosResponse,
	InternalAxiosRequestConfig,
} from "axios";
import axios, { AxiosHeaders, isAxiosError } from "axios";
import type { IAxiosRetryConfig } from "axios-retry";
import axiosRetry, { DEFAULT_OPTIONS } from "axios-retry";

import { RequestPacer } from "./RequestPacer";
import { type ErrorResponse, ShipStationError } from "./v2/types/models/Error";

export interface ShipStationRequestOptions
	extends Pick<AxiosRequestConfig, "data" | "params" | "url"> {
	method?: "GET" | "POST" | "PUT" | "DELETE";
}

/**
 * Axios request config for a single SDK call. It is applied after the SDK's own settings, so it can override them.
 * Headers are merged with the auth headers, and `"axios-retry"` is merged over the client's `retryConfig`.
 */
export type ShipStationCallOptions = AxiosRequestConfig;

export interface ShipStationRateLimit {
	/** Evenly spaced, retries included. Defaults to 200 for v2 and 40 for v1. */
	requestsPerMinute?: number;
	/** Pause after a 429 with no `Retry-After` or `X-Rate-Limit-Reset`. Defaults to 30 seconds. */
	fallbackPauseMs?: number;
}

export interface ShipStationAttempt {
	api: "v1" | "v2";
	method: string;
	url?: string;
	status?: number;
	/** Set when no response arrived, e.g. `ECONNABORTED` */
	errorCode?: string;
	retryCount: number;
	/** Time spent waiting for a rate-limit turn */
	delayMs: number;
	durationMs: number;
	/** Set when this attempt paused the client */
	pauseMs?: number;
	/** From the v2 error body; ShipStation has no request ID header */
	requestId?: string;
}

export interface ShipStationOptions {
	credentials: {
		v1?: {
			apiKey: string;
			apiSecret: string;
			partnerKey?: string;
		};
		v2?: {
			apiKey: string;
			mock?: boolean;
		};
	};
	requestConfig?: Omit<
		AxiosRequestConfig,
		"baseURL" | "headers" | "axios-retry" | keyof ShipStationRequestOptions
	>;
	/** `retryDelay` is not applied to retries of a 429; they go out when the client pause ends. */
	retryConfig?: IAxiosRetryConfig;
	rateLimit?: {
		v1?: ShipStationRateLimit;
		v2?: ShipStationRateLimit;
	};
	/** Called after every HTTP attempt, retries included. Errors it throws are ignored. */
	onAttempt?: (attempt: ShipStationAttempt) => void;
}

const DEFAULT_FALLBACK_PAUSE_MS = 30_000;
// The headers count in whole seconds, so wait past them
const HEADER_PAUSE_BUFFER_MS = 1000;
// The limits are per minute, so don't let a bad header freeze the client
const MAX_HEADER_PAUSE_MS = 60_000;

// Gateway failures and v1 errors don't carry the v2 error body
const isErrorResponse = (data: unknown): data is ErrorResponse =>
	typeof data === "object" &&
	data !== null &&
	"errors" in data &&
	Array.isArray(data.errors) &&
	data.errors.length > 0;

const readRequestId = (data: unknown) =>
	typeof data === "object" &&
	data !== null &&
	"request_id" in data &&
	typeof data.request_id === "string"
		? data.request_id
		: undefined;

const getHeader = ({ headers }: AxiosResponse, name: string) =>
	headers instanceof AxiosHeaders ? headers.get(name) : undefined;

const parseRetryAfter = (response: AxiosResponse) => {
	const value = getHeader(response, "retry-after");
	if (typeof value !== "string" || value.trim() === "") {
		return undefined;
	}

	const seconds = Number(value);
	const ms = Number.isNaN(seconds)
		? new Date(value).valueOf() - Date.now()
		: seconds * 1000;

	return Number.isNaN(ms) ? undefined : Math.max(0, ms);
};

const parseNumberHeader = (response: AxiosResponse, name: string) => {
	const value = getHeader(response, name);
	const number = Number(value);
	return typeof value === "string" && value.trim() !== "" && number >= 0
		? number
		: undefined;
};

// v1 sends X-Rate-Limit-* on every response; v2 documents only Retry-After, so the others are used when present
const headerPauseMs = (response: AxiosResponse) => {
	const isRateLimited = response.status === 429;
	const remaining = parseNumberHeader(response, "x-rate-limit-remaining");
	const resetSeconds = parseNumberHeader(response, "x-rate-limit-reset");

	const waitMs =
		(isRateLimited ? parseRetryAfter(response) : undefined) ??
		((isRateLimited || remaining === 0) && resetSeconds !== undefined
			? resetSeconds * 1000
			: undefined);

	return waitMs === undefined
		? undefined
		: Math.min(waitMs + HEADER_PAUSE_BUFFER_MS, MAX_HEADER_PAUSE_MS);
};

type RetryDelay = NonNullable<IAxiosRetryConfig["retryDelay"]>;

// The client pause already delays the retry of a 429, so don't add retryDelay on top
const skipDelayOn429 =
	(retryDelay: RetryDelay = DEFAULT_OPTIONS.retryDelay): RetryDelay =>
	(retryCount, error) =>
		error.response?.status === 429 ? 0 : retryDelay(retryCount, error);

interface AttemptTiming {
	delayMs: number;
	sentAt: number;
}

export default abstract class BaseAPI {
	private readonly type: "v1" | "v2";
	private readonly baseURL: string;
	private readonly http: AxiosInstance;
	private readonly pacer: RequestPacer;
	private readonly fallbackPauseMs: number;
	private readonly onAttempt?: ShipStationOptions["onAttempt"];
	// axios copies the config for every retry, so each attempt's config object is its own key
	private readonly attempts = new WeakMap<
		InternalAxiosRequestConfig,
		AttemptTiming
	>();
	protected authHeaders?: Record<string, string>;

	constructor(
		type: typeof this.type,
		baseUrl: string,
		defaultRequestsPerMinute: number,
		options: ShipStationOptions,
	) {
		const rateLimit = options.rateLimit?.[type];

		this.type = type;
		this.baseURL = baseUrl;
		this.http = axios.create(options.requestConfig);
		this.pacer = new RequestPacer(
			rateLimit?.requestsPerMinute ?? defaultRequestsPerMinute,
		);
		this.fallbackPauseMs =
			rateLimit?.fallbackPauseMs ?? DEFAULT_FALLBACK_PAUSE_MS;
		this.onAttempt = options.onAttempt;

		// Added before axios-retry so it sees each attempt before axios-retry resends it
		this.http.interceptors.response.use(
			(response) => {
				this.afterAttempt(response.config, response);
				return response;
			},
			(error: unknown) => {
				if (isAxiosError(error) && error.config) {
					this.afterAttempt(error.config, error.response, error);
				}
				return Promise.reject(error);
			},
		);

		// Always installed so a per-call "axios-retry" policy works without retryConfig
		const retryConfig = options.retryConfig ?? { retries: 0 };
		axiosRetry(this.http, {
			...retryConfig,
			retryDelay: skipDelayOn429(retryConfig.retryDelay),
		});

		// Request interceptors run in reverse order, so this waits before axios-retry starts the timeout clock
		this.http.interceptors.request.use(async (config) => {
			const queuedAt = Date.now();
			await this.pacer.waitForTurn(config.signal);

			const sentAt = Date.now();
			this.attempts.set(config, { delayMs: sentAt - queuedAt, sentAt });
			return config;
		});
	}

	public request = async <T>(
		requestData: ShipStationRequestOptions,
		callOptions?: ShipStationCallOptions,
	) => {
		if (!this.authHeaders) {
			throw new Error(`Credentials are not set for the ${this.type} API`);
		}

		const callRetryConfig = callOptions?.["axios-retry"];

		try {
			const response = await this.http.request<T>({
				baseURL: this.baseURL,
				...requestData,
				...callOptions,
				...(callRetryConfig?.retryDelay && {
					"axios-retry": {
						...callRetryConfig,
						retryDelay: skipDelayOn429(callRetryConfig.retryDelay),
					},
				}),
				headers: { ...this.authHeaders, ...callOptions?.headers },
			});

			return response.data;
		} catch (error) {
			// Keep the axios error for anything else so its status survives
			const data = (error as AxiosError).response?.data;
			if (!isErrorResponse(data)) {
				throw error;
			}

			throw new ShipStationError(data);
		}
	};

	private afterAttempt(
		config: InternalAxiosRequestConfig,
		response?: AxiosResponse,
		error?: AxiosError,
	) {
		let pauseMs = response && headerPauseMs(response);
		if (pauseMs === undefined && response?.status === 429) {
			pauseMs = this.fallbackPauseMs;
		}
		if (pauseMs !== undefined) {
			this.pacer.pauseFor(pauseMs);
		}

		if (!this.onAttempt) {
			return;
		}

		const timing = this.attempts.get(config);
		try {
			this.onAttempt({
				api: this.type,
				method: (config.method ?? "get").toUpperCase(),
				url: config.url,
				status: response?.status,
				errorCode: response ? undefined : error?.code,
				retryCount: config["axios-retry"]?.retryCount ?? 0,
				delayMs: timing?.delayMs ?? 0,
				durationMs: timing ? Date.now() - timing.sentAt : 0,
				pauseMs,
				requestId: readRequestId(response?.data),
			});
		} catch {
			// Ignore hook errors
		}
	}
}
