import type { Reporter } from '@cupboard/reporter';
import { describe, expect, it, vi } from 'vitest';

import { createCloudflareClient } from './auth.ts';
import { claimSecretCleanupApi, removeClaimSecret } from './claim-secret.ts';
import { createCloudflareApi } from './cloudflare-api.ts';
import { cloudflareAccountIdSchema, scriptNameSchema } from './identifiers.ts';

const accountId = cloudflareAccountIdSchema.parse('acc-1');
const controlScriptName = scriptNameSchema.parse('cupboard');

const silentReporter: Reporter = {
	phase: (_label, body) =>
		Promise.resolve(body({ fact: vi.fn(), warn: vi.fn() })),
	progress: (_label, _options, body) =>
		Promise.resolve(body({ advance: vi.fn(), fact: vi.fn(), warn: vi.fn() })),
	steps: (_label, body) =>
		Promise.resolve(
			body({
				message: vi.fn(),
				group: () => ({ message: vi.fn(), success: vi.fn(), error: vi.fn() }),
				warn: vi.fn()
			})
		),
	result: vi.fn(),
	data: vi.fn(),
	warn: vi.fn(),
	info: vi.fn(),
	success: vi.fn(),
	step: vi.fn(),
	error: vi.fn()
};

/**
 * A Cloudflare API endpoint that records the requests that reach it. Like
 * `fetch`, it refuses a request whose signal has aborted.
 */
function recordingCloudflare(): {
	readonly requests: string[];
	readonly fetcher: typeof fetch;
} {
	const requests: string[] = [];
	const fetcher: typeof fetch = (input, init) => {
		if (init?.signal?.aborted === true) {
			return Promise.reject(new DOMException('aborted', 'AbortError'));
		}

		const request = new Request(input, init);
		requests.push(`${request.method} ${new URL(request.url).pathname}`);

		return Promise.resolve(
			Response.json({ success: true, errors: [], messages: [], result: {} })
		);
	};

	return { requests, fetcher };
}

describe('removeClaimSecret after the run is interrupted', () => {
	const aborted = AbortSignal.abort();

	it.each([
		{
			name: "the run's aborted signal cannot remove the secret",
			cleanup: false,
			requests: [],
			warnings: 1
		},
		{
			name: 'the cleanup API removes the secret with its own signal',
			cleanup: true,
			requests: [
				'DELETE /client/v4/accounts/acc-1/workers/scripts/cupboard/secrets/CUPBOARD_SIGNUP_SECRET'
			],
			warnings: 0
		}
	])('$name', async ({ cleanup, requests, warnings }) => {
		const cloudflare = recordingCloudflare();
		const clientWithSignal = (signal: AbortSignal) =>
			createCloudflareClient('token', cloudflare.fetcher, undefined, signal);
		const shown: string[] = [];

		await removeClaimSecret(
			{
				reporter: () => silentReporter,
				warn: (message) => {
					shown.push(message);
				}
			},
			cleanup
				? claimSecretCleanupApi(clientWithSignal, accountId)
				: createCloudflareApi(clientWithSignal(aborted), accountId),
			controlScriptName
		);

		expect({
			requests: cloudflare.requests,
			warnings: shown.length
		}).toStrictEqual({ requests, warnings });
	});
});
