import { atWarningOrAbove, startCapture } from '@cupboard/logger/testing';
import { cacheNameSchema, type CacheScope } from '@cupboard/nix-store/scalars';
import { buildInputsCapability } from '@cupboard/protocol/build-inputs';
import {
	type BuildInputsDocument,
	buildInputsDocumentSchema
} from '@cupboard/protocol/publish-plan';
import {
	acceptCapabilitiesHeader,
	confirmPresentCapability,
	publicationCapability,
	pushRootWritesCapability,
	uploadCapabilitiesHeader,
	uploadGraceFactsCapability,
	uploadNegotiateRequestSchema,
	type UploadPathNegotiationFields,
	uploadPlanMaxPaths,
	uploadRequestMaxBodyBytes,
	uploadRequestMaxPathsHeader
} from '@cupboard/protocol/upload';
import { StatusCodes } from 'http-status-codes';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { pushClientFor } from './push-client.ts';

const credential = {
	pushId: 'push-1',
	accessKeyId: 'access',
	secretAccessKey: 'secret',
	sessionToken: 'session',
	endpoint: 'https://r2.test',
	bucket: 'blobs',
	expiresAt: '2099-01-01T00:00:00.000Z'
};
// The renewal tests run their clients at this time, so a credential that
// expires then needs renewing and `credential` does not.
const expiringAt = '2030-01-01T00:00:00.000Z';
const pushAccepts = `${publicationCapability},${confirmPresentCapability},${pushRootWritesCapability}`;
const buildInput = `${'1'.repeat(32)}-compiler`;

function hash(index: number): string {
	return String(index).padStart(32, '0');
}

function storePath(index: number): string {
	return `/nix/store/${hash(index)}-path`;
}

// Distinct basenames of about 200 bytes each.
function basenames(count: number): string[] {
	return Array.from(
		{ length: count },
		(_, index) => `${hash(index)}-${'x'.repeat(170)}`
	);
}

function negotiation(
	index: number,
	references: readonly string[] = []
): UploadPathNegotiationFields {
	return {
		storePathHash: hash(index),
		storePath: storePath(index),
		narHash: `sha256:${'0'.repeat(52)}`,
		narSize: 1,
		references: [...references]
	};
}

function document(
	paths: Readonly<Record<string, readonly string[]>>
): BuildInputsDocument {
	return buildInputsDocumentSchema.parse({
		version: 1,
		buildInputsVersion: 1,
		paths
	});
}

interface RecordedRequest {
	readonly path: string;
	readonly accepts: string | null;
	readonly body: unknown;
	readonly bytes: number;
}

type UploadRoute = 'plan' | 'preview' | 'negotiate';

function routeOf(path: string): UploadRoute {
	if (path.endsWith('/uploads/plan')) {
		return 'plan';
	}

	return path.endsWith('/uploads/preview') ? 'preview' : 'negotiate';
}

// Answers the credential request, echoing the capabilities in `echoed`, and
// skips every path of a plan, preview or negotiation request. `maxPaths` gives
// the maximum that each kind of request advertises.
function uploadServer(
	echoed: readonly string[],
	maxPaths: Partial<Record<UploadRoute, string>> = {}
): {
	readonly fetcher: typeof fetch;
	readonly requests: RecordedRequest[];
} {
	const requests: RecordedRequest[] = [];
	const fetcher: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		const text = await request.text();
		const path = new URL(request.url).pathname;
		requests.push({
			path,
			accepts: request.headers.get(acceptCapabilitiesHeader),
			body: JSON.parse(text),
			bytes: Buffer.byteLength(text)
		});

		if (path.endsWith('/uploads/credential')) {
			return Response.json(credential, {
				headers: { [uploadCapabilitiesHeader]: echoed.join(',') }
			});
		}

		const route = routeOf(path);
		const body = z
			.object({ paths: uploadNegotiateRequestSchema.shape.paths })
			.parse(JSON.parse(text));
		const advertised = maxPaths[route];
		const headers = {
			[uploadCapabilitiesHeader]: uploadGraceFactsCapability,
			...(advertised !== undefined && {
				[uploadRequestMaxPathsHeader]: advertised
			})
		};

		if (route !== 'plan') {
			return Response.json(
				{
					uploads: body.paths.map((entry) => ({
						action: 'skip',
						storePathHash: entry.storePathHash,
						narHash: entry.narHash
					}))
				},
				{ headers }
			);
		}

		return Response.json(
			{
				cacheGeneration: 1,
				pushExpiresAt: '2099-01-01T00:00:00.000Z',
				uploads: body.paths.map((entry) => ({
					action: 'skip',
					storePathHash: entry.storePathHash,
					narHash: entry.narHash,
					operationId: entry.storePathHash.padStart(64, '0'),
					r2Key: `staging-v2/acme/push-1/${entry.storePathHash}.nar.zst`
				}))
			},
			{ headers }
		);
	};

	return { fetcher, requests };
}

function pathCounts(
	requests: readonly RecordedRequest[],
	route: UploadRoute
): number[] {
	return requests
		.filter(
			({ path }) => !path.endsWith('/credential') && routeOf(path) === route
		)
		.map(
			({ body }) =>
				z.object({ paths: z.array(z.unknown()) }).parse(body).paths.length
		);
}

const named: CacheScope = { kind: 'named', name: cacheNameSchema.parse('ci') };
const withBuildInput = {
	...negotiation(0),
	buildInputs: [buildInput],
	buildInputsVersion: 1
};

describe('pushClientFor with build inputs', () => {
	it.each([
		{
			name: 'a server that echoes the capability',
			cache: { kind: 'default' } as const,
			buildInputs: document({ [storePath(0)]: [buildInput] }),
			echoed: [publicationCapability, buildInputsCapability],
			requests: [
				{
					path: '/t/acme/uploads/credential',
					accepts: `${pushAccepts},${buildInputsCapability}`,
					body: {}
				},
				{
					path: '/t/acme/uploads/plan',
					accepts: `${pushAccepts},${buildInputsCapability}`,
					body: { pushId: 'push-1', paths: [withBuildInput, negotiation(1)] }
				}
			]
		},
		{
			name: 'a named cache',
			cache: named,
			buildInputs: document({ [storePath(0)]: [buildInput] }),
			echoed: [publicationCapability, buildInputsCapability],
			requests: [
				{
					path: '/t/acme/cache/ci/uploads/credential',
					accepts: `${pushAccepts},${buildInputsCapability}`,
					body: {}
				},
				{
					path: '/t/acme/cache/ci/uploads/plan',
					accepts: `${pushAccepts},${buildInputsCapability}`,
					body: { pushId: 'push-1', paths: [withBuildInput, negotiation(1)] }
				}
			]
		},
		{
			name: 'a server that negotiates without publication',
			cache: { kind: 'default' } as const,
			buildInputs: document({ [storePath(0)]: [buildInput] }),
			echoed: [buildInputsCapability],
			requests: [
				{
					path: '/t/acme/uploads/credential',
					accepts: `${pushAccepts},${buildInputsCapability}`,
					body: {}
				},
				{
					path: '/t/acme/uploads',
					accepts: `${uploadGraceFactsCapability},${buildInputsCapability}`,
					body: { pushId: 'push-1', paths: [withBuildInput, negotiation(1)] }
				}
			]
		},
		{
			name: 'an older server',
			cache: { kind: 'default' } as const,
			buildInputs: document({ [storePath(0)]: [buildInput] }),
			echoed: [publicationCapability],
			requests: [
				{
					path: '/t/acme/uploads/credential',
					accepts: `${pushAccepts},${buildInputsCapability}`,
					body: {}
				},
				{
					path: '/t/acme/uploads/plan',
					accepts: pushAccepts,
					body: { pushId: 'push-1', paths: [negotiation(0), negotiation(1)] }
				}
			]
		},
		{
			name: 'no build inputs to send',
			cache: { kind: 'default' } as const,
			buildInputs: undefined,
			echoed: [publicationCapability, buildInputsCapability],
			requests: [
				{ path: '/t/acme/uploads/credential', accepts: pushAccepts, body: {} },
				{
					path: '/t/acme/uploads/plan',
					accepts: pushAccepts,
					body: { pushId: 'push-1', paths: [negotiation(0), negotiation(1)] }
				}
			]
		}
	])(
		'sends build inputs and accepts them only after the echo, for $name',
		async ({ cache, buildInputs, echoed, requests }) => {
			const server = uploadServer(echoed);
			const client = pushClientFor(
				new URL('https://cupboard.test/t/acme'),
				'token',
				{
					cache,
					fetcher: server.fetcher,
					...(buildInputs !== undefined && { buildInputs })
				}
			);

			await client.negotiate({ paths: [negotiation(0), negotiation(1)] });

			expect(
				server.requests.map(({ path, accepts, body }) => ({
					path,
					accepts,
					body
				}))
			).toStrictEqual(requests);
		}
	);

	it.each([
		{
			name: 'more than 8,192 build inputs',
			references: [],
			buildInputs: Array.from(
				{ length: 8193 },
				(_, index) => `${hash(index)}-input`
			)
		},
		{
			name: 'build inputs over 1,000,000 bytes of JSON',
			references: [],
			buildInputs: basenames(5000)
		},
		{
			name: 'references and build inputs over 1,500,000 bytes of JSON',
			references: basenames(6000),
			buildInputs: basenames(2000)
		}
	])(
		'publishes a path with $name without them and warns',
		async ({ references, buildInputs }) => {
			const server = uploadServer([
				publicationCapability,
				buildInputsCapability
			]);
			const client = pushClientFor(
				new URL('https://cupboard.test/t/acme'),
				'token',
				{
					cache: { kind: 'default' },
					fetcher: server.fetcher,
					buildInputs: document({
						[storePath(0)]: buildInputs,
						[storePath(1)]: [buildInput]
					})
				}
			);
			const capture = startCapture();

			try {
				await client.negotiate({
					paths: [negotiation(0, references), negotiation(1)]
				});

				expect({
					planned: server.requests
						.filter(({ path }) => path.endsWith('/uploads/plan'))
						.map(({ body }) => body),
					warnings: atWarningOrAbove(capture.logs).map(
						({ level, properties }) => ({ level, properties })
					)
				}).toStrictEqual({
					planned: [
						{
							pushId: 'push-1',
							paths: [
								negotiation(0, references),
								{
									...negotiation(1),
									buildInputs: [buildInput],
									buildInputsVersion: 1
								}
							]
						}
					],
					warnings: [
						{
							level: 'warning',
							properties: {
								storePath: storePath(0),
								buildInputs: buildInputs.length
							}
						}
					]
				});
			} finally {
				capture.stop();
			}
		}
	);

	it('pages plan requests with large build inputs within the body limit', async () => {
		const indices = Array.from({ length: 40 }, (_, index) => index);
		const inputs = basenames(2000);
		const listed = Object.fromEntries(
			indices.map((index) => [storePath(index), inputs])
		);
		const server = uploadServer([publicationCapability, buildInputsCapability]);
		const client = pushClientFor(
			new URL('https://cupboard.test/t/acme'),
			'token',
			{
				cache: { kind: 'default' },
				fetcher: server.fetcher,
				buildInputs: document(listed)
			}
		);

		const negotiated = await client.negotiate({
			paths: indices.map((index) => negotiation(index))
		});

		expect({
			pages: pathCounts(server.requests, 'plan'),
			isEveryRequestWithinLimit: server.requests.every(
				({ bytes }) => bytes <= uploadRequestMaxBodyBytes
			),
			decisions: negotiated.uploads.map(({ storePathHash }) => storePathHash)
		}).toStrictEqual({
			pages: [20, 20],
			isEveryRequestWithinLimit: true,
			decisions: indices.map((index) => hash(index))
		});
	});

	it('keeps the earlier preview limits after the echo', async () => {
		const count = 3101;
		const server = uploadServer(
			[publicationCapability, buildInputsCapability],
			{
				preview: '3000'
			}
		);
		const client = pushClientFor(
			new URL('https://cupboard.test/t/acme'),
			'token',
			{
				cache: { kind: 'default' },
				fetcher: server.fetcher,
				buildInputs: document({ [storePath(0)]: [buildInput] })
			}
		);

		await client.negotiate({ paths: [negotiation(0)] });
		await client.preview({
			paths: Array.from({ length: count }, (_, index) => negotiation(index))
		});

		const previews = server.requests.filter(
			({ path }) => routeOf(path) === 'preview'
		);
		expect({
			pages: pathCounts(server.requests, 'preview'),
			accepts: new Set(previews.map(({ accepts }) => accepts))
		}).toStrictEqual({
			// Without `build-inputs-v1`, the advertised maximum is not capped at
			// `buildInputsUploadMaxPaths`.
			pages: [100, 3000, 1],
			accepts: new Set([uploadGraceFactsCapability])
		});
	});

	it('pages plan requests by the maximum that plan responses advertise', async () => {
		const server = uploadServer([publicationCapability], {
			preview: '150',
			plan: '50'
		});
		const client = pushClientFor(
			new URL('https://cupboard.test/t/acme'),
			'token',
			{ cache: { kind: 'default' }, fetcher: server.fetcher }
		);

		await client.preview({ paths: [negotiation(0)] });
		await client.negotiate({
			paths: Array.from({ length: 201 }, (_, index) => negotiation(index))
		});

		expect(pathCounts(server.requests, 'plan')).toStrictEqual([100, 50, 50, 1]);
	});

	it('starts plan pages at the most paths that a plan request may contain', async () => {
		const server = uploadServer([publicationCapability]);
		const client = pushClientFor(
			new URL('https://cupboard.test/t/acme'),
			'token',
			{ cache: { kind: 'default' }, fetcher: server.fetcher }
		);
		const count = 2 * uploadPlanMaxPaths + 1;

		await client.negotiate({
			paths: Array.from({ length: count }, (_, index) => negotiation(index))
		});

		expect(pathCounts(server.requests, 'plan')).toStrictEqual([
			uploadPlanMaxPaths,
			uploadPlanMaxPaths,
			1
		]);
	});

	it('keeps the header on every page of a call after a renewal without the echo', async () => {
		const echoed = [publicationCapability, buildInputsCapability];
		const server = uploadServer(echoed);
		const indices = Array.from(
			{ length: uploadPlanMaxPaths + 1 },
			(_, index) => index
		);
		const last = indices.length - 1;
		let credentials = 0;
		let renewed: Promise<undefined> | undefined;
		const fetcher: typeof fetch = async (input, init) => {
			const request = new Request(input, init);

			if (request.url.endsWith('/uploads/credential')) {
				credentials += 1;

				// The first credential expires at the injected time, inside the
				// refresh margin, so the upload below renews it. The renewal
				// succeeds without the echo.
				return credentials === 1
					? Response.json(
							{ ...credential, expiresAt: expiringAt },
							{ headers: { [uploadCapabilitiesHeader]: echoed.join(',') } }
						)
					: Response.json(credential);
			}

			if (renewed === undefined && request.url.endsWith('/uploads/plan')) {
				const { promise, resolve } = Promise.withResolvers<undefined>();
				renewed = promise;
				// The uploader reads the body only after the renewed credential has
				// been accepted, so reading it marks the renewal as done. The body
				// then fails, so the upload stops before it reaches R2.
				const body = new ReadableStream<Uint8Array>({
					pull: (controller) => {
						resolve(undefined);
						controller.error(new Error('the test stops the upload'));
					}
				});
				void client.uploadNar('staging/key', body).catch(() => {
					// The failing body ends the upload.
				});
				await renewed;
			}

			return server.fetcher(request);
		};
		const client = pushClientFor(
			new URL('https://cupboard.test/t/acme'),
			'token',
			{
				cache: { kind: 'default' },
				fetcher,
				buildInputs: document({ [storePath(last)]: [buildInput] }),
				now: () => Date.parse(expiringAt)
			}
		);

		await client.negotiate({
			paths: indices.map((index) => negotiation(index))
		});

		const plans = server.requests.filter(
			({ path }) => routeOf(path) === 'plan'
		);
		expect({
			credentials,
			accepts: plans.map(({ accepts }) => accepts),
			lastPath: plans
				.flatMap(
					({ body }) =>
						z.object({ paths: z.array(z.unknown()) }).parse(body).paths
				)
				.at(-1)
		}).toStrictEqual({
			credentials: 2,
			accepts: [
				`${pushAccepts},${buildInputsCapability}`,
				`${pushAccepts},${buildInputsCapability}`
			],
			lastPath: {
				...negotiation(last),
				buildInputs: [buildInput],
				buildInputsVersion: 1
			}
		});
	});

	it('keeps build inputs after a credential renewal that fails without the echo', async () => {
		const echoed = [publicationCapability, buildInputsCapability];
		const server = uploadServer(echoed);
		let credentials = 0;
		const fetcher: typeof fetch = async (input, init) => {
			const request = new Request(input, init);

			if (!request.url.endsWith('/uploads/credential')) {
				return server.fetcher(request);
			}

			credentials += 1;

			if (credentials === 1) {
				// Expires at the injected time, inside the refresh margin, so the
				// next upload renews it.
				return Response.json(
					{ ...credential, expiresAt: expiringAt },
					{ headers: { [uploadCapabilitiesHeader]: echoed.join(',') } }
				);
			}

			return Response.json(
				{
					defined: false,
					code: 'FORBIDDEN',
					status: StatusCodes.FORBIDDEN,
					message: 'Renewal refused'
				},
				{ status: StatusCodes.FORBIDDEN }
			);
		};
		const client = pushClientFor(
			new URL('https://cupboard.test/t/acme'),
			'token',
			{
				cache: { kind: 'default' },
				fetcher,
				buildInputs: document({ [storePath(0)]: [buildInput] }),
				now: () => Date.parse(expiringAt)
			}
		);

		await client.negotiate({ paths: [negotiation(1)] });
		let renewal = 'uploaded';

		try {
			await client.uploadNar('staging/key', new ReadableStream());
		} catch {
			renewal = 'refused';
		}

		await client.negotiate({ paths: [negotiation(0)] });

		const plans = server.requests.filter(
			({ path }) => routeOf(path) === 'plan'
		);
		expect({
			renewal,
			credentials,
			plans: plans.map(({ accepts, body }) => ({ accepts, body }))
		}).toStrictEqual({
			renewal: 'refused',
			credentials: 2,
			plans: [
				{
					accepts: `${pushAccepts},${buildInputsCapability}`,
					body: { pushId: 'push-1', paths: [negotiation(1)] }
				},
				{
					accepts: `${pushAccepts},${buildInputsCapability}`,
					body: { pushId: 'push-1', paths: [withBuildInput] }
				}
			]
		});
	});
});
