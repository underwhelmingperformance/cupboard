import { ORPCError } from '@orpc/client';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import { tenantRpc } from './orpc.ts';
import { canGrantBuildInputs } from './server-features.ts';

const probePath = `/t/acme/build-inputs/${'0'.repeat(32)}`;

function probeClient(answer: () => Promise<Response>): {
	readonly read: ReturnType<typeof tenantRpc>['buildInputs']['read'];
	readonly requests: string[];
} {
	const requests: string[] = [];
	const rpc = tenantRpc(new URL('https://cupboard.test/t/acme'), {
		credential: 'token',
		random: () => 0,
		fetcher: (input, init) => {
			const request = new Request(input, init);
			requests.push(`${request.method} ${new URL(request.url).pathname}`);

			return answer();
		}
	});

	return { read: rpc.buildInputs.read, requests };
}

function orpcError(status: number, code: string): Response {
	return Response.json(
		{ defined: false, code, status, message: code },
		{ status }
	);
}

describe('canGrantBuildInputs', () => {
	it.each([
		{
			name: 'a server that reads build inputs',
			answer: () =>
				Response.json({ storePathHash: '0'.repeat(32), status: 'absent' }),
			expected: true
		},
		{
			name: 'a token without cache:content-read',
			answer: () => orpcError(StatusCodes.FORBIDDEN, 'FORBIDDEN'),
			expected: true
		},
		{
			name: 'a server without the procedure',
			answer: () =>
				new Response('Not found\n', { status: StatusCodes.NOT_FOUND }),
			expected: false
		}
	])('answers $expected for $name', async ({ answer, expected }) => {
		const probe = probeClient(() => Promise.resolve(answer()));

		expect({
			answer: await canGrantBuildInputs(probe.read),
			requests: probe.requests
		}).toStrictEqual({ answer: expected, requests: [`GET ${probePath}`] });
	});

	it.each([
		{
			name: 'an oRPC not-found error',
			answer: () =>
				Promise.resolve(orpcError(StatusCodes.NOT_FOUND, 'NOT_FOUND')),
			failure: { orpcStatus: StatusCodes.NOT_FOUND }
		},
		{
			name: 'a plain 403',
			answer: () =>
				Promise.resolve(
					new Response('Forbidden\n', { status: StatusCodes.FORBIDDEN })
				),
			failure: { orpcStatus: StatusCodes.FORBIDDEN }
		},
		{
			name: 'a server error',
			answer: () =>
				Promise.resolve(
					orpcError(StatusCodes.INTERNAL_SERVER_ERROR, 'INTERNAL_SERVER_ERROR')
				),
			failure: { name: 'CupboardHttpError' }
		},
		{
			name: 'a transport failure',
			answer: () => Promise.reject(new TypeError('fetch failed')),
			failure: { name: 'TypeError' }
		}
	])('propagates $name', async ({ answer, failure }) => {
		const probe = probeClient(answer);
		let error: unknown;

		try {
			await canGrantBuildInputs(probe.read);
		} catch (error_) {
			error = error_;
		}

		expect(
			error instanceof ORPCError
				? { orpcStatus: error.status }
				: { name: error instanceof Error ? error.name : String(error) }
		).toStrictEqual(failure);
	});
});
