import {
	cacheNameSchema,
	type CacheScope,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import { readUserSchema } from '@cupboard/shared/http';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';

import { attestedServedPaths } from './destination-probe.ts';
import { DestinationProbeResponseError } from './destination-probe-errors.ts';

const baseUrl = new URL('https://cupboard.example.test/t/owner');
const defaultCache: CacheScope = { kind: 'default' };
const appHash = '0123456789abcdfghijklmnpqrsvwxyz';
const otherHash = '3123456789abcdfghijklmnpqrsvwxyz';
const appPath = storePathSchema.parse(`/nix/store/${appHash}-app`);
const otherPath = storePathSchema.parse(`/nix/store/${otherHash}-other`);
// The probe groups paths by hash part, so this fixture gives two paths the
// same hash and different names.
const appDevelopmentPath = storePathSchema.parse(
	`/nix/store/${appHash}-app-dev`
);

interface ProbeRequest {
	readonly url: string;
	readonly authorization?: string;
}

function requestUrl(input: RequestInfo | URL): string {
	if (typeof input === 'string') {
		return input;
	}

	return input instanceof URL ? input.href : input.url;
}

function attestationList(
	predicateType = 'https://slsa.dev/provenance/v1'
): Response {
	return Response.json({
		attestations: [{ digest: 'a'.repeat(64), predicateType, size: 512 }]
	});
}

function notFound(): Response {
	return new Response('', { status: StatusCodes.NOT_FOUND });
}

// Serves an attestation list for each hash in `attested` and a 404 for every
// other hash, recording the URL and credentials of each request.
function recordingFetcher(
	attested: ReadonlySet<string>,
	requests: ProbeRequest[]
): typeof fetch {
	return (input, init) => {
		const url = requestUrl(input);
		const authorization = new Headers(init?.headers).get('authorization');
		requests.push({
			url,
			...(authorization !== null && { authorization })
		});

		return Promise.resolve(
			[...attested].some((hash) => url.endsWith(`/attestations/${hash}`))
				? attestationList()
				: notFound()
		);
	};
}

describe('attestedServedPaths', () => {
	// A build-origin statement covers each accepted receipt subject. Without a
	// build-provenance statement, the path is not attested as built.
	it('passes over a path whose only attestation is not build provenance', async () => {
		const attested = await attestedServedPaths({
			baseUrl,
			cache: defaultCache,
			paths: [appPath],
			fetcher: () =>
				Promise.resolve(
					attestationList(
						'https://github.com/underwhelmingperformance/cupboard/predicate/build-origin/v2'
					)
				)
		});

		expect([...attested]).toStrictEqual([]);
	});

	it('reports the paths whose attestation list the cache serves', async () => {
		const requests: ProbeRequest[] = [];

		const attested = await attestedServedPaths({
			baseUrl,
			cache: defaultCache,
			paths: [appPath, otherPath],
			fetcher: recordingFetcher(new Set([appHash]), requests)
		});

		expect({ attested: [...attested], requests }).toStrictEqual({
			attested: [appPath],
			requests: [
				{
					url: `https://cupboard.example.test/t/owner/attestations/${appHash}`
				},
				{
					url: `https://cupboard.example.test/t/owner/attestations/${otherHash}`
				}
			]
		});
	});

	it('requests a shared hash once from a named cache and reports both paths as attested', async () => {
		const requests: ProbeRequest[] = [];

		const attested = await attestedServedPaths({
			baseUrl,
			cache: { kind: 'named', name: cacheNameSchema.parse('nightly') },
			paths: [appPath, appDevelopmentPath],
			credentials: { user: readUserSchema.parse('alice'), password: 'secret' },
			fetcher: recordingFetcher(new Set([appHash]), requests)
		});

		expect({ attested: [...attested], requests }).toStrictEqual({
			attested: [appPath, appDevelopmentPath],
			requests: [
				{
					url: `https://cupboard.example.test/t/owner/cache/nightly/attestations/${appHash}`,
					authorization: `Basic ${btoa('alice:secret')}`
				}
			]
		});
	});

	it('sends no request when there are no paths to ask about', async () => {
		const requests: ProbeRequest[] = [];

		const attested = await attestedServedPaths({
			baseUrl,
			cache: defaultCache,
			paths: [],
			fetcher: recordingFetcher(new Set(), requests)
		});

		expect({ attested: [...attested], requests }).toStrictEqual({
			attested: [],
			requests: []
		});
	});

	it.each([
		{
			name: 'an empty attestation list',
			response: (): Response => Response.json({ attestations: [] })
		},
		{ name: 'a 404', response: notFound }
	])('reads $name as no attestation', async ({ response }) => {
		const attested = await attestedServedPaths({
			baseUrl,
			cache: defaultCache,
			paths: [appPath],
			fetcher: () => Promise.resolve(response())
		});

		expect([...attested]).toStrictEqual([]);
	});

	it.each([
		{
			name: 'a server error',
			response: (): Response =>
				new Response('', { status: StatusCodes.INTERNAL_SERVER_ERROR }),
			status: StatusCodes.INTERNAL_SERVER_ERROR
		},
		{
			name: 'a refused read',
			response: (): Response =>
				new Response('', { status: StatusCodes.UNAUTHORIZED }),
			status: StatusCodes.UNAUTHORIZED
		},
		{
			name: 'a body that is not an attestation list',
			response: (): Response => Response.json({ attestations: 'many' }),
			status: StatusCodes.OK
		},
		{
			name: 'a body that is not JSON',
			response: (): Response =>
				new Response('<html></html>', { status: StatusCodes.OK }),
			status: StatusCodes.OK
		}
	])('refuses to answer after $name', async ({ response, status }) => {
		let error: unknown;

		try {
			await attestedServedPaths({
				baseUrl,
				cache: defaultCache,
				paths: [appPath],
				fetcher: () => Promise.resolve(response())
			});
		} catch (error_: unknown) {
			error = error_;
		}

		expect({
			isProbeError: error instanceof DestinationProbeResponseError,
			url:
				error instanceof DestinationProbeResponseError ? error.url : undefined,
			status:
				error instanceof DestinationProbeResponseError
					? error.status
					: undefined
		}).toStrictEqual({
			isProbeError: true,
			url: `https://cupboard.example.test/t/owner/attestations/${appHash}`,
			status
		});
	});
});
