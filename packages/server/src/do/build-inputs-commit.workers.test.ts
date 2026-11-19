import { storePathNameMaxLength } from '@cupboard/nix-store/scalars';
import { buildInputsCapability } from '@cupboard/protocol/build-inputs';
import { publicationStagingKey } from '@cupboard/protocol/publication';
import {
	acceptCapabilitiesHeader,
	buildInputsCapabilityRequiredErrorCode,
	publicationCapability,
	uploadCapabilitiesHeader,
	uploadNegotiateResponseSchema,
	type UploadPathMetadata,
	uploadPathMetadataSchema,
	type UploadPathNegotiation,
	uploadPathNegotiationSchema,
	uploadPlanResponseSchema,
	uploadPreviewResponseSchema,
	uploadRequestMaxBodyBytes,
	uploadRequestMaxPathsHeader,
	uploadRequestTooLargeErrorCode
} from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import * as schema from '../db/schema.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedFetch,
	closeSessionAndWait,
	commitPath,
	commitPipelineOf,
	commitSharedPath,
	commitUpload,
	currentNarObjectKey,
	currentServer,
	drivenDirectly,
	handlerFetch,
	initialise,
	openCommitSession,
	putNarBytes,
	resetTestServer,
	resolvedCache,
	syntheticNarHash,
	syntheticStorePathHash,
	testPushId,
	uploadPathNegotiation,
	useTestServer,
	type VerifiableNar,
	verifiableNar
} from '../test-support.ts';

import { buildInputColumns, unrecorded } from './build-inputs.test-support.ts';

const negotiationAnswerSchema = z.union([
	uploadNegotiateResponseSchema,
	uploadPreviewResponseSchema,
	z.object({ code: z.string(), data: z.unknown().optional() })
]);

// Paths whose build inputs take about 1 MB each.
function largePaths(length: number): UploadPathNegotiation[] {
	return Array.from({ length }, (_, index) =>
		uploadPathNegotiationSchema.parse({
			storePathHash: syntheticStorePathHash(100 + index),
			storePath: `/nix/store/${syntheticStorePathHash(100 + index)}-app`,
			narHash: syntheticNarHash(100 + index),
			narSize: 1,
			references: [],
			buildInputs: Array.from(
				{ length: 4000 },
				(_, offset) =>
					`${String(index * 4000 + offset).padStart(32, '0')}-${'a'.repeat(storePathNameMaxLength)}`
			),
			buildInputsVersion: 1
		})
	);
}

const gcc = `${'a'.repeat(32)}-gcc-14.2.0`;
const source = `${'b'.repeat(32)}-source`;
const make = `${'c'.repeat(32)}-gnumake-4.4.1`;

// The build inputs that a client sends, unsorted, and the columns of a row
// that records them.
const sent = { buildInputs: [source, gcc], buildInputsVersion: 3 };
const recorded = {
	buildInputsJson: JSON.stringify([gcc, source]),
	buildInputsVersion: 3
};

function pathMetadata(
	nar: VerifiableNar,
	storePathHash: string,
	edges: Partial<typeof sent> = {}
): UploadPathMetadata {
	return uploadPathMetadataSchema.parse({
		storePathHash,
		storePath: `/nix/store/${storePathHash}-app`,
		narHash: nar.narHash,
		narSize: nar.narSize,
		fileHash: nar.fileHash,
		fileSize: nar.narBytes.byteLength,
		compression: 'zstd',
		references: [],
		...edges
	});
}

// Publishes one path through `publish-batch`, as current clients do.
async function publishPath(
	token: string,
	metadata: UploadPathMetadata,
	nar: VerifiableNar
): Promise<void> {
	const response = await authorisedFetch('/uploads/plan', token, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(metadata.buildInputs !== undefined && {
				[acceptCapabilitiesHeader]: buildInputsCapability
			})
		},
		body: JSON.stringify({
			pushId: testPushId,
			paths: [uploadPathNegotiation(metadata)]
		})
	});
	const plan = uploadPlanResponseSchema.parse(await response.json());
	const [planned] = plan.uploads;
	if (planned === undefined) {
		throw new Error('Expected a planned entry');
	}
	await putNarBytes(
		publicationStagingKey(fixtureTenant, testPushId, planned.operationId),
		nar
	);
	const session = await openCommitSession(
		token,
		undefined,
		publicationCapability
	);
	try {
		session.send({
			op: 'publish-batch',
			pushId: testPushId,
			entries: [
				{
					operationId: planned.operationId,
					cacheGeneration: plan.cacheGeneration,
					metadata: uploadPathNegotiation(metadata),
					blob: { fileHash: metadata.fileHash, fileSize: metadata.fileSize }
				}
			]
		});
		await session.nextFrame();
		await session.nextFrame();
	} finally {
		await closeSessionAndWait(session.socket);
	}
	await commitUpload(token, planned.operationId);
}

const flows = [
	{
		flow: 'an upload',
		publish: async (
			token: string,
			metadata: UploadPathMetadata,
			nar: VerifiableNar
		) => {
			await commitPath(token, metadata, nar);
		}
	},
	{
		flow: 'a commit that reuses a NAR',
		publish: async (
			token: string,
			metadata: UploadPathMetadata,
			nar: VerifiableNar
		) => {
			await commitPath(token, pathMetadata(nar, '9'.repeat(32)), nar);
			await commitSharedPath(token, metadata);
		}
	},
	{ flow: 'a publication', publish: publishPath }
];

describe('build inputs at commit', () => {
	beforeEach(async () => {
		vi.setSystemTime(vi.getRealSystemTime());
		await resetTestServer();
	});

	it.each(
		flows.flatMap(({ flow, publish }) => [
			{
				flow,
				publish,
				client: 'a client that sends build inputs',
				edges: sent,
				expected: recorded
			},
			{
				flow,
				publish,
				client: 'a client that sends none',
				edges: {},
				expected: unrecorded
			}
		])
	)(
		'records on the row that $flow creates the build inputs from $client',
		async ({ publish, edges, expected }) => {
			const token = await initialise();
			const nar = await verifiableNar('build-inputs-commit');
			const metadata = pathMetadata(nar, '1'.repeat(32), edges);

			await publish(token, metadata, nar);

			expect(await buildInputColumns(metadata.storePathHash)).toStrictEqual(
				expected
			);
		}
	);

	it.each([
		{ existing: 'build inputs', stored: sent, expected: recorded },
		{ existing: 'no build inputs', stored: {}, expected: unrecorded }
	])(
		'keeps the $existing of a row that a later reservation finds',
		async ({ stored, expected }) => {
			await initialise();
			const nar = await verifiableNar('build-inputs-reservation');
			const first = pathMetadata(nar, '1'.repeat(32), stored);
			const later = pathMetadata(nar, '1'.repeat(32), {
				buildInputs: [make],
				buildInputsVersion: 4
			});

			const outcomes = await runInDurableObject(
				currentServer(),
				async (instance) => {
					const pipeline = drivenDirectly(commitPipelineOf(instance));
					const cache = resolvedCache(instance.context);

					return [
						await pipeline.reserveNarInfoRow(cache, first, 0),
						await pipeline.reserveNarInfoRow(cache, later, 0)
					];
				}
			);

			expect({
				outcomes,
				columns: await buildInputColumns(first.storePathHash)
			}).toStrictEqual({
				outcomes: [
					{ kind: 'reserved', generation: 0 },
					{ kind: 'mine', generation: 0 }
				],
				columns: expected
			});
		}
	);

	// The replacement is a new row of the path, so it takes the build inputs of
	// the publication that replaces the lost row.
	it.each([
		{
			client: 'a client that sends build inputs',
			edges: sent,
			expected: recorded
		},
		{ client: 'a client that sends none', edges: {}, expected: unrecorded }
	])(
		'gives the row that replaces a path with a missing NAR the build inputs from $client',
		async ({ edges, expected }) => {
			const token = await initialise();
			const lostNar = await verifiableNar('build-inputs-lost');
			const lost = pathMetadata(lostNar, '1'.repeat(32), {
				buildInputs: [make],
				buildInputsVersion: 1
			});
			await commitPath(token, lost, lostNar);
			await env.BLOBS.delete(await currentNarObjectKey(lostNar.narHash));
			const nar = await verifiableNar('build-inputs-replacement');
			const replacement = pathMetadata(nar, '1'.repeat(32), edges);

			await publishPath(token, replacement, nar);

			expect({
				narHash: await runInDurableObject(
					currentServer(),
					(instance) =>
						instance.context.db
							.select({ narHash: schema.narInfos.narHash })
							.from(schema.narInfos)
							.where(eq(schema.narInfos.storePathHash, lost.storePathHash))
							.get()?.narHash
				),
				columns: await buildInputColumns(lost.storePathHash)
			}).toStrictEqual({ narHash: nar.narHash, columns: expected });
		}
	);

	it.each([
		{
			accepted: `${publicationCapability},${buildInputsCapability}`,
			echoed: `${publicationCapability},${buildInputsCapability}`
		},
		{ accepted: buildInputsCapability, echoed: buildInputsCapability },
		{ accepted: publicationCapability, echoed: publicationCapability }
	])(
		'echoes $echoed on a credential that accepts $accepted',
		async ({ accepted, echoed }) => {
			const response = await authorisedFetch(
				'/uploads/credential',
				await initialise(),
				{
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						[acceptCapabilitiesHeader]: accepted
					},
					body: '{}'
				}
			);
			await response.body?.cancel();

			expect({
				status: response.status,
				echoed: response.headers.get(uploadCapabilitiesHeader)
			}).toStrictEqual({ status: StatusCodes.OK, echoed });
		}
	);

	// Paths whose build inputs take about 1 MB each. Six fit in one request but
	// not in one page by size, and twelve exceed the request body limit.
	it.each([
		{
			paths: 6,
			expected: (paths: readonly UploadPathNegotiation[]) => ({
				status: StatusCodes.OK,
				body: {
					uploads: paths.map((path) => [path.storePathHash, 'upload'])
				}
			})
		},
		{
			paths: 12,
			expected: () => ({
				status: StatusCodes.REQUEST_TOO_LONG,
				body: {
					code: uploadRequestTooLargeErrorCode,
					data: { maxBytes: uploadRequestMaxBodyBytes }
				}
			})
		}
	])(
		'answers a negotiation of $paths paths with large build inputs',
		async ({ paths: length, expected }) => {
			await useTestServer(fixtureTenant);
			const token = await initialise();
			const paths = largePaths(length);

			const response = await handlerFetch(`/t/${fixtureTenant}/uploads`, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${token}`,
					'content-type': 'application/json',
					[acceptCapabilitiesHeader]: buildInputsCapability
				},
				body: JSON.stringify({ pushId: testPushId, paths })
			});
			const json = negotiationAnswerSchema.parse(await response.json());

			expect({
				status: response.status,
				body:
					'uploads' in json
						? {
								uploads: json.uploads.map((upload) => [
									upload.storePathHash,
									upload.action
								])
							}
						: { code: json.code, data: json.data }
			}).toStrictEqual(expected(paths));
		}
	);

	it('refuses a plan request larger than the request body limit', async () => {
		const token = await initialise();

		const response = await authorisedFetch('/uploads/plan', token, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				[acceptCapabilitiesHeader]: buildInputsCapability
			},
			body: JSON.stringify({ pushId: testPushId, paths: largePaths(12) })
		});
		const json = negotiationAnswerSchema.parse(await response.json());

		expect({
			status: response.status,
			body: 'uploads' in json ? json : { code: json.code, data: json.data }
		}).toStrictEqual({
			status: StatusCodes.REQUEST_TOO_LONG,
			body: {
				code: uploadRequestTooLargeErrorCode,
				data: { maxBytes: uploadRequestMaxBodyBytes }
			}
		});
	});

	// The capability decides the advertised maximum, so a client that does not
	// accept build inputs sees the value that it saw before build inputs.
	it.each([
		{ client: 'a client that accepts build inputs', isBuildInputsClient: true },
		{ client: 'any other client', isBuildInputsClient: false }
	])(
		'advertises the maximum paths for $client',
		async ({ isBuildInputsClient }) => {
			await useTestServer(fixtureTenant);
			const token = await initialise();

			const response = await handlerFetch(
				`/t/${fixtureTenant}/uploads/preview`,
				{
					method: 'POST',
					headers: {
						authorization: `Bearer ${token}`,
						'content-type': 'application/json',
						...(isBuildInputsClient && {
							[acceptCapabilitiesHeader]: buildInputsCapability
						})
					},
					body: JSON.stringify({ paths: [] })
				}
			);
			await response.body?.cancel();

			expect({
				status: response.status,
				advertised: response.headers.get(uploadRequestMaxPathsHeader)
			}).toStrictEqual({
				status: StatusCodes.OK,
				advertised: isBuildInputsClient ? '2047' : '51200'
			});
		}
	);

	// A client sends build inputs only on a request that accepts the
	// capability, so the tenant object refuses any other.
	it.each([
		{ procedure: 'negotiation', path: '/uploads', withPushId: true },
		{ procedure: 'preview', path: '/uploads/preview', withPushId: false },
		{ procedure: 'plan', path: '/uploads/plan', withPushId: true }
	])(
		'refuses a $procedure with build inputs that does not accept the capability',
		async ({ path, withPushId }) => {
			const token = await initialise();
			const paths = largePaths(1);

			const response = await authorisedFetch(path, token, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(
					withPushId ? { pushId: testPushId, paths } : { paths }
				)
			});
			const json = negotiationAnswerSchema.parse(await response.json());

			expect({
				status: response.status,
				code: 'code' in json ? json.code : undefined
			}).toStrictEqual({
				status: StatusCodes.BAD_REQUEST,
				code: buildInputsCapabilityRequiredErrorCode
			});
		}
	);

	// Through the Worker the request is refused, by the Worker or by the tenant
	// object. The unit tests of `answerUploadsInChunks` show that the Worker
	// refuses it itself.
	it.each([
		{ procedure: 'negotiation', path: 'uploads', withPushId: true },
		{ procedure: 'preview', path: 'uploads/preview', withPushId: false }
	])(
		'answers through the Worker a $procedure with build inputs that does not accept the capability with a refusal',
		async ({ path, withPushId }) => {
			await useTestServer(fixtureTenant);
			const token = await initialise();
			const paths = largePaths(1);

			const response = await handlerFetch(`/t/${fixtureTenant}/${path}`, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${token}`,
					'content-type': 'application/json'
				},
				body: JSON.stringify(
					withPushId ? { pushId: testPushId, paths } : { paths }
				)
			});
			const json = negotiationAnswerSchema.parse(await response.json());

			expect({
				status: response.status,
				code: 'code' in json ? json.code : undefined
			}).toStrictEqual({
				status: StatusCodes.BAD_REQUEST,
				code: buildInputsCapabilityRequiredErrorCode
			});
		}
	);

	// A request of one page is forwarded unpaged from the bytes that the Worker
	// read, and a negotiation's hints come from the request that it validated.
	it.each([
		{ procedure: 'negotiation', path: 'uploads', withPushId: true },
		{ procedure: 'preview', path: 'uploads/preview', withPushId: false }
	])(
		'answers a one-page $procedure that accepts build inputs',
		async ({ path, withPushId }) => {
			await useTestServer(fixtureTenant);
			const token = await initialise();
			const paths = Array.from({ length: 3 }, (_, index) =>
				uploadPathNegotiationSchema.parse({
					storePathHash: syntheticStorePathHash(200 + index),
					storePath: `/nix/store/${syntheticStorePathHash(200 + index)}-app`,
					narHash: syntheticNarHash(200 + index),
					narSize: 1,
					references: [],
					buildInputs: [gcc, source],
					buildInputsVersion: 1
				})
			);

			const response = await handlerFetch(`/t/${fixtureTenant}/${path}`, {
				method: 'POST',
				headers: {
					authorization: `Bearer ${token}`,
					'content-type': 'application/json',
					[acceptCapabilitiesHeader]: buildInputsCapability
				},
				body: JSON.stringify(
					withPushId ? { pushId: testPushId, paths } : { paths }
				)
			});
			const json = negotiationAnswerSchema.parse(await response.json());

			expect({
				status: response.status,
				decisions:
					'uploads' in json
						? json.uploads.map((upload) => [
								upload.storePathHash,
								upload.action
							])
						: json
			}).toStrictEqual({
				status: StatusCodes.OK,
				decisions: paths.map((entry) => [entry.storePathHash, 'upload'])
			});
		}
	);

	// Nine paths with about 1 MB of references each make a plan body just over
	// the 8 MiB limit and under the earlier limit of about 16 MB.
	it.each([
		{
			client: 'a client that accepts build inputs',
			isBuildInputsClient: true,
			expected: {
				status: StatusCodes.REQUEST_TOO_LONG,
				code: uploadRequestTooLargeErrorCode
			}
		},
		{
			client: 'any other client',
			isBuildInputsClient: false,
			expected: { status: StatusCodes.OK, code: undefined }
		}
	])(
		'applies the plan body limit for $client',
		async ({ isBuildInputsClient, expected }) => {
			const token = await initialise();
			const paths = Array.from({ length: 9 }, (_, index) =>
				uploadPathNegotiationSchema.parse({
					storePathHash: syntheticStorePathHash(300 + index),
					storePath: `/nix/store/${syntheticStorePathHash(300 + index)}-app`,
					narHash: syntheticNarHash(300 + index),
					narSize: 1,
					references: Array.from(
						{ length: 4000 },
						(_, offset) =>
							`${String(index * 4000 + offset).padStart(32, '0')}-${'a'.repeat(storePathNameMaxLength)}`
					)
				})
			);
			const body = JSON.stringify({ pushId: testPushId, paths });

			const response = await authorisedFetch('/uploads/plan', token, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					...(isBuildInputsClient && {
						[acceptCapabilitiesHeader]: buildInputsCapability
					})
				},
				body
			});
			const json: unknown = await response.json();

			expect({
				isBetweenLimits:
					body.length > uploadRequestMaxBodyBytes && body.length < 16_000_000,
				status: response.status,
				code:
					typeof json === 'object' && json !== null && 'code' in json
						? json.code
						: undefined
			}).toStrictEqual({ isBetweenLimits: true, ...expected });
		}
	);
});
