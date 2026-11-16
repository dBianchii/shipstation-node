# shipstation-node

[![npm version](https://img.shields.io/npm/v/shipstation-node.svg)](https://www.npmjs.com/package/shipstation-node)
[![Build Status](https://img.shields.io/github/actions/workflow/status/rip-technologies/shipstation-node/ci.yaml?branch=master)](https://github.com/rip-technologies/shipstation-node/actions)
[![License](https://img.shields.io/github/license/rip-technologies/shipstation-node.svg)](https://github.com/rip-technologies/shipstation-node/blob/master/LICENSE)
[![Downloads](https://img.shields.io/npm/dm/shipstation-node.svg)](https://www.npmjs.com/package/shipstation-node)

Unofficial ShipStation API wrapper for Node.js, providing a modern, type-safe interface to both the v1 and v2 ShipStation APIs.

---

## Features

- Full support for both ShipStation v1 and v2 APIs
- Complete TypeScript support and request validation with detailed type definitions
- Automatic rate limiting: evenly paced requests, retries included, and a client-wide pause on 429
- Mock API support for testing (only available for v2 API)
- Promise-based async/await interface
- Customizable request configurations with automatic retries

---

## Installation

Requires Node.js 22 or later.

### Package manager

Using npm:

```bash
$ npm install shipstation-node
```

Using pnpm:

```bash
$ pnpm add shipstation-node
```

Using bun:

```bash
$ bun add shipstation-node
```

---

## Usage

### Create a Client Instance

All requests should be made through an instantiated `ShipStation` class. You only need to set the credentials for the API version(s) you plan to use.

```ts
import ShipStation from 'shipstation-node';

// Create instance
const shipstation = new ShipStation({
  credentials: {
    // For making v1 API calls
    v1: { apiKey, apiSecret },
    // For making v2 API calls
    v2: { apiKey }
  }
});
```

### Making API Requests

You can make API requests to both v1 and v2 endpoints:

```ts
// v1 Example - List Tags (https://www.shipstation.com/docs/api/accounts/list-tags/)
const tags = await shipstation.v1.accounts.listTags();

// v2 Example: Get Tags (https://docs.shipstation.com/openapi/tags/list_tags)
const tagsV2 = await shipstation.v2.tags.get();

// Working with orders (https://www.shipstation.com/docs/api/orders/list-orders/)
const orders = await shipstation.v1.orders.list({
  pageSize: 100,
  orderStatus: 'awaiting_shipment'
});
```

### Mock API Support

Use the mock API for testing (v2 API only):

```ts
const shipstation = new ShipStation({
  credentials: { v2: { mock: true } }
});
```

---

## Advanced Configuration

### Retry Configuration

Configure automatic retry behavior for failed API calls using [axios-retry](https://www.npmjs.com/package/axios-retry):

```ts
const shipstation = new ShipStation({
  credentials: {
    /* ... */
  },
  retryConfig: {
    retries: 3,
    retryDelay: (retryCount) => retryCount * 1000,
    retryCondition: (error) => {
      return axios.isRetryableError(error);
    }
  }
});
```

### Request Configuration

Customize the underlying [axios](https://www.npmjs.com/package/axios) request settings:

```ts
const shipstation = new ShipStation({
  credentials: {
    /* ... */
  },
  requestConfig: {
    timeout: 5000,
    headers: {
      'Custom-Header': 'value'
    }
  }
});
```

### Per-call Options

Every SDK method takes an optional last argument: an axios request config for that call only. It is applied after the
SDK's own settings, so it can override them.

```ts
const rates = await shipstation.v2.rates.get(request, {
  timeout: 15_000,
  'axios-retry': { retries: 2, retryCondition, retryDelay }
});
```

### Rate Limiting

Each `ShipStation` instance paces its own requests per API version. It starts at most one request every
`60_000 / requestsPerMinute` ms, in the order the calls were made. Every attempt waits for a turn, and that includes
retries. The defaults match ShipStation's limits: 200 requests per minute for v2 and 40 for v1. Set a lower rate when
several processes share one API key.

```ts
const shipstation = new ShipStation({
  credentials: {
    /* ... */
  },
  rateLimit: {
    v2: { requestsPerMinute: 150 }
  }
});
```

A 429 pauses the whole client. Requests that are already waiting and requests made later all wait until the
`Retry-After` time has passed. If a 429 has no `Retry-After`, the client uses `X-Rate-Limit-Reset` instead. If neither
header is there, it pauses for `fallbackPauseMs`, which defaults to 30 seconds.

The client also pauses before a 429 happens. When a response has `X-Rate-Limit-Remaining: 0`, it waits until
`X-Rate-Limit-Reset` has passed, as ShipStation's v1 docs ask. These headers count requests from every process using
the key, so they catch limits that pacing one client can't see. v1 sends them on every response; v2 doesn't document
them, so for v2 they are used only if present.

Pauses taken from a header last 1 second longer than the header says, because the headers count in whole seconds.
They are also capped at 60 seconds, since ShipStation's limits are per minute. If the limit still holds after that,
the next 429 pauses the client again.

Whether a 429 is retried is still up to your retry policy (`retryConfig` or a per-call `'axios-retry'`). If it is,
the retry goes out as soon as the pause ends, and `retryDelay` is not added on top of the pause. All other retries
still wait for `retryDelay`. Because the pause counts as waiting for a turn, it does not use up the request's `timeout`.

Pacing is per instance. To share one limit across your app, share one `ShipStation` instance.

To limit how long one call may wait for its turn, give it a signal. A call that is aborted while waiting leaves the
queue without being sent, and rejects like any canceled axios request:

```ts
const rates = await shipstation.v2.rates.get(request, { signal: AbortSignal.timeout(30_000) });
```

Note that the signal also covers the request itself once it is sent.

### Per-attempt Hook

`onAttempt` is called after every HTTP attempt, whether it succeeded or failed. It is useful for logging and metrics.

```ts
const shipstation = new ShipStation({
  credentials: {
    /* ... */
  },
  onAttempt: ({ api, method, url, status, errorCode, retryCount, delayMs, durationMs, pauseMs, requestId }) => {
    logger.info('shipstation attempt', { api, method, url, status, errorCode, retryCount, delayMs, durationMs, pauseMs, requestId });
  }
});
```

- `delayMs` is how long the attempt waited for its turn.
- `pauseMs` is set when the attempt paused the client: on a 429, or when the response said no requests were left.
- `requestId` comes from the `request_id` field of v2 error bodies. ShipStation does not document a request ID header.
- Errors thrown by the hook are ignored.

---

## Migrating from 2.x to 3.0

The API is unchanged. What changed:

- **Node.js 22 or later is required.** Rate limiting now uses [p-queue](https://www.npmjs.com/package/p-queue), which
  is ESM-only and needs Node.js 22. CommonJS projects keep working, because Node.js 22 and later can `require()` ES
  modules.
- **Requests are spaced out.** Before, a client could send its whole per-minute allowance at once. Now it starts one
  request every `60_000 / requestsPerMinute` ms (300 ms for v2, 1.5 s for v1), and retries wait for a turn too. Set
  `rateLimit` if you need a different rate.
- **A 429 pauses the whole client.** All requests on the client wait until 1 second past `Retry-After`. A response
  with `X-Rate-Limit-Remaining: 0` pauses it too, until `X-Rate-Limit-Reset` has passed.
- **`retryDelay` no longer applies to retries of a 429.** The retry goes out when the pause ends. Other retries are
  unchanged.

See [Rate Limiting](#rate-limiting) for details.

---

## Contributing

Contributions are welcome! Please follow these steps:

1. Fork the repository
2. Create a new branch (`git checkout -b feature-name`)
3. Commit your changes (`git commit -m 'Add feature'`)
4. Test your changes (`bun run build`, `bun run check`, and `bun run test`)
5. Push to the branch (`git push origin feature-name`)
6. Open a pull request with a thorough description

---

## Links

- [v1 API Documentation](https://www.shipstation.com/docs/api/)
- [v2 API Documentation](https://docs.shipstation.com/getting-started)
- [Changelog](https://github.com/rip-technologies/shipstation-node/releases)
- [Issues](https://github.com/rip-technologies/shipstation-node/issues)
- [GitHub Repository](https://github.com/rip-technologies/shipstation-node)

---

## Support

If you encounter any issues, feel free to open an [issue](https://github.com/rip-technologies/shipstation-node/issues).

---

## License

This project is licensed under the [MIT License](https://github.com/rip-technologies/shipstation-node/blob/main/LICENSE).

---

## Author

Created and maintained by [Jake Leventhal](https://github.com/jakeleventhal).
