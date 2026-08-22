import {
	narInfoGenerationSchema,
	type Sha256HexDigest,
	sha256HexDigestSchema,
	type StorePathHash
} from '@cupboard/nix-store/scalars';
import {
	attestationAttachResponseSchema,
	attestationDecisionSchema,
	attestationListSchema,
	attestationNegotiateResponseSchema,
	attestationUploadDecisionSchema,
	type ParsedAttestationDecision
} from '@cupboard/protocol/attestations';
import {
	uploadActionDecisionSchema,
	uploadNegotiateResponseSchema
} from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { sha256HexBytes } from '../crypto/crypto.ts';
import * as schema from '../db/schema.ts';
import { AttestationPathNotFoundError } from '../errors.ts';
import {
	attestationListObjectKey,
	casObjectKey,
	type R2ObjectKey
} from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	attestationReferenceRows,
	authorisedWorkerFetch,
	cacheWriteGrants,
	casObjectRows,
	clearBlobStorage,
	commitUploadViaWorker,
	fixtureWorkerServer,
	handlerFetch,
	hexBytes,
	initialiseViaWorker,
	issueTokenForTenant,
	narDigestHex,
	pendingAttestationRows,
	provisionFixtureTenant,
	provisionNamedTenant,
	putNarBytes,
	readFetch,
	resetTestServer,
	sigstoreBundleBytes,
	tenantCasBlobRows,
	tenantUsageRow,
	testPushId,
	testPushIdFor,
	testServerFor,
	uploadMetadata,
	uploadPathNegotiation,
	verifiableNar
} from '../test-support.ts';

import { AttestationCasService } from './attestation-cas-service.ts';
import { AttestationsService } from './attestations-service.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';

const predicateType = 'https://slsa.dev/provenance/v1';

// Orders by UTF-16 code unit, matching the default `<`/`>` comparison.
function compareById(left: { id: string }, right: { id: string }): number {
	if (left.id < right.id) {
		return -1;
	}

	if (left.id > right.id) {
		return 1;
	}

	return 0;
}
const orpcErrorBodySchema = z.strictObject({
	defined: z.boolean(),
	code: z.string(),
	status: z.number(),
	message: z.string(),
	data: z.unknown().optional()
});
const storePathHashCursor = { next: 0 };

function orpcErrorBodyShape(body: unknown): {
	readonly defined: boolean;
	readonly code: string;
	readonly status: number;
	readonly data: unknown;
} {
	const parsed = orpcErrorBodySchema.parse(body);

	return {
		defined: parsed.defined,
		code: parsed.code,
		status: parsed.status,
		data: parsed.data
	};
}

describe('attestation attach and reads', () => {
	beforeEach(async () => {
		vi.useRealTimers();
		await resetTestServer();
		await clearBlobStorage();
	});

	it('marks an absent attestation list as uncacheable', async () => {
		await initialiseViaWorker();
		const storePathHash = uniqueStorePathHash();

		const response = await readFetch(`/attestations/${storePathHash}`);

		expect({
			status: response.status,
			cacheControl: response.headers.get('cache-control')
		}).toStrictEqual({
			status: StatusCodes.NOT_FOUND,
			cacheControl: 'no-store'
		});
	});

	it('attaches a DSSE bundle and serves descriptors from the filed edge', async () => {
		const { token, metadata, bundle, digest } = await committedPathBundle();

		const attached = await attachBundle(token, metadata.storePathHash, bundle);
		const list = await readFetch(`/attestations/${metadata.storePathHash}`);
		const bundleRead = await readFetch(`/attestation-bundles/${digest}`);
		const bundleBytes = new Uint8Array(await bundleRead.arrayBuffer());

		expect({
			attached,
			listStatus: list.status,
			listControl: list.headers.get('cache-control'),
			listBody: attestationListSchema.parse(await list.json()),
			bundleStatus: bundleRead.status,
			bundleControl: bundleRead.headers.get('cache-control'),
			bundleBytes: [...bundleBytes]
		}).toStrictEqual({
			attached: {
				storePathHash: metadata.storePathHash,
				digest,
				predicateType,
				status: 'attached'
			},
			listStatus: StatusCodes.OK,
			listControl: 'no-store',
			listBody: {
				attestations: [{ digest, predicateType, size: bundle.byteLength }]
			},
			bundleStatus: StatusCodes.OK,
			bundleControl: 'no-store',
			bundleBytes: [...bundle]
		});
	});

	it('rejects a bundle filed against a different NAR subject', async () => {
		const token = await initialiseViaWorker();
		const storePathHash = uniqueStorePathHash();
		const nar = await verifiableNar('attestation-subject-good');
		const metadata = uploadMetadata({
			storePathHash,
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		await pushPathThroughTenant(fixtureTenant, token, metadata, nar);
		const other = await verifiableNar('attestation-subject-wrong');
		const bundle = sigstoreBundleBytes(narDigestHex(other.narHash));

		const response = await attachBundleResponse(
			token,
			metadata.storePathHash,
			bundle
		);
		const list = await readFetch(`/attestations/${metadata.storePathHash}`);
		const body = orpcErrorBodyShape(await response.json());

		expect({
			status: response.status,
			body,
			refs: await attestationReferenceRows(),
			objects: await casObjectRows(),
			listStatus: list.status
		}).toStrictEqual({
			status: StatusCodes.UNPROCESSABLE_ENTITY,
			body: {
				defined: false,
				code: 'UNPROCESSABLE_CONTENT',
				status: StatusCodes.UNPROCESSABLE_ENTITY,
				data: undefined
			},
			refs: [],
			objects: [],
			listStatus: StatusCodes.NOT_FOUND
		});
	});

	it('rejects non-DSSE Sigstore content without filing a CAS object', async () => {
		const { token, metadata } = await committedPathBundle();
		const encoder = new TextEncoder();
		const garbage = encoder.encode('not a sigstore bundle');

		const response = await attachBundleResponse(
			token,
			metadata.storePathHash,
			garbage
		);
		const body = orpcErrorBodyShape(await response.json());

		expect({
			status: response.status,
			body,
			refs: await attestationReferenceRows(),
			objects: await casObjectRows()
		}).toStrictEqual({
			status: StatusCodes.UNPROCESSABLE_ENTITY,
			body: {
				defined: false,
				code: 'UNPROCESSABLE_CONTENT',
				status: StatusCodes.UNPROCESSABLE_ENTITY,
				data: undefined
			},
			refs: [],
			objects: []
		});
	});

	it('does not materialise a missing descriptor list during a read', async () => {
		const { token, metadata, bundle } = await committedPathBundle();
		await attachBundle(token, metadata.storePathHash, bundle);
		const key = attestationListObjectKey(fixtureTenant, metadata.storePathHash);
		await env.BLOBS.delete(key);
		const beforeRead = {
			refs: await attestationReferenceRows(),
			objects: await casObjectRows(),
			descriptorPresent: (await env.BLOBS.head(key)) !== null
		};

		const list = await readFetch(`/attestations/${metadata.storePathHash}`);
		const head = await readFetch(`/attestations/${metadata.storePathHash}`, {
			method: 'HEAD'
		});

		expect({
			getStatus: list.status,
			headStatus: head.status,
			beforeRead,
			afterRead: {
				refs: await attestationReferenceRows(),
				objects: await casObjectRows(),
				descriptorPresent: (await env.BLOBS.head(key)) !== null
			}
		}).toStrictEqual({
			getStatus: StatusCodes.NOT_FOUND,
			headStatus: StatusCodes.NOT_FOUND,
			beforeRead,
			afterRead: beforeRead
		});
	});

	it('gates descriptor and bundle reads in private mode', async () => {
		const { token, metadata, bundle, digest } = await committedPathBundle();
		await attachBundle(token, metadata.storePathHash, bundle);
		await provisionFixtureTenant({
			readMode: 'private',
			read: { user: 'alice', password: 'secret' }
		});
		const authorised = {
			headers: { authorization: `Basic ${btoa('alice:secret')}` }
		};

		const listDenied = await readFetch(
			`/attestations/${metadata.storePathHash}`
		);
		const list = await readFetch(
			`/attestations/${metadata.storePathHash}`,
			authorised
		);
		const bundleDenied = await readFetch(`/attestation-bundles/${digest}`);
		const bundleRead = await readFetch(
			`/attestation-bundles/${digest}`,
			authorised
		);

		expect({
			listDenied: listDenied.status,
			list: list.status,
			listControl: list.headers.get('cache-control'),
			bundleDenied: bundleDenied.status,
			bundle: bundleRead.status,
			bundleControl: bundleRead.headers.get('cache-control')
		}).toStrictEqual({
			listDenied: StatusCodes.UNAUTHORIZED,
			list: StatusCodes.OK,
			listControl: 'no-store',
			bundleDenied: StatusCodes.UNAUTHORIZED,
			bundle: StatusCodes.OK,
			bundleControl: 'no-store'
		});
	});

	it('negotiates reuse only from this tenant own attestation edges', async () => {
		const { token, metadata, bundle, digest, nar } =
			await committedPathBundle();
		await attachBundle(token, metadata.storePathHash, bundle);
		const issuer = await provisionNamedTenant('other');
		const otherToken = await issueTokenForTenant(
			testServerFor('other'),
			issuer,
			cacheWriteGrants()
		);
		await pushPathThroughTenant('other', otherToken, metadata, nar);

		const own = await negotiate(token, metadata.storePathHash, digest);
		const other = await negotiateTenant(
			'other',
			otherToken,
			metadata.storePathHash,
			digest
		);
		const otherUpload = attestationUploadDecisionSchema.parse(other);

		expect({
			own,
			other: otherUpload,
			pending: await pendingAttestationRowsFor('other')
		}).toStrictEqual({
			own: {
				action: 'skip',
				storePathHash: metadata.storePathHash,
				digest
			},
			other: {
				action: 'upload',
				storePathHash: metadata.storePathHash,
				digest,
				uploadId: otherUpload.uploadId,
				r2Key: otherUpload.r2Key,
				expiresAt: otherUpload.expiresAt
			},
			pending: [
				{
					id: otherUpload.uploadId,
					r2Key: otherUpload.r2Key,
					expiresAt: otherUpload.expiresAt
				}
			]
		});
	});

	it('404s a referenced bundle whose shared CAS object is absent', async () => {
		const { token, metadata, bundle, digest } = await committedPathBundle();
		await attachBundle(token, metadata.storePathHash, bundle);
		await env.BLOBS.delete(casObjectKey(digest));

		const response = await readFetch(`/attestation-bundles/${digest}`);

		expect(response.status).toBe(StatusCodes.NOT_FOUND);
	});

	it('rejects over-quota attach before promoting a CAS object', async () => {
		const { token, metadata, nar, bundle, digest } =
			await committedPathBundle();
		const quotaBytes = nar.narBytes.byteLength + bundle.byteLength - 1;
		await provisionFixtureTenant({ quotaBytes });

		const response = await attachBundleResponse(
			token,
			metadata.storePathHash,
			bundle
		);

		const body = orpcErrorBodyShape(await response.json());

		expect({
			status: response.status,
			body,
			refs: await attestationReferenceRows(),
			presence: await tenantCasBlobRows(),
			objects: await casObjectRows(),
			casObjectPresent: (await env.BLOBS.head(casObjectKey(digest))) !== null,
			usage: await tenantUsageRow()
		}).toStrictEqual({
			status: StatusCodes.INSUFFICIENT_STORAGE,
			body: {
				defined: false,
				code: 'INSUFFICIENT_STORAGE',
				status: StatusCodes.INSUFFICIENT_STORAGE,
				data: undefined
			},
			refs: [],
			presence: [],
			objects: [],
			casObjectPresent: false,
			usage: {
				bytes: nar.narBytes.byteLength,
				narinfos: 1,
				blobs: 1,
				casBytes: 0,
				casBlobs: 0,
				quotaBytes
			}
		});
	});

	it('does not file an attestation against a generation replaced during attach', async () => {
		const { token, metadata, bundle, digest } = await committedPathBundle();
		const replacement = await verifiableNar('attestation-race-replacement');
		const decision = attestationUploadDecisionSchema.parse(
			await negotiate(token, metadata.storePathHash, digest)
		);

		await env.BLOBS.put(decision.r2Key, bundle, { sha256: hexBytes(digest) });

		const error = await runInDurableObject(
			fixtureWorkerServer(),
			async (instance) => {
				class RacingAttestationCasService extends AttestationCasService {
					override async measureStagedBundle(
						key: R2ObjectKey
					): ReturnType<typeof instance.measureAttestationBundle> {
						const measured = await super.measureStagedBundle(key);
						instance.context.db
							.update(schema.narInfos)
							.set({
								narHash: replacement.narHash,
								generation: narInfoGenerationSchema.parse(1)
							})
							.where(eqStorePath(metadata.storePathHash))
							.run();

						return measured;
					}
				}
				const attestations = new AttestationsService(
					instance.context,
					new RacingAttestationCasService(instance.context),
					new NarInfoObjectsService(instance.context)
				);

				try {
					return await attestations.attach('', decision.uploadId);
				} catch (error: unknown) {
					return error;
				}
			}
		);
		expect(error).toBeInstanceOf(AttestationPathNotFoundError);
		if (!(error instanceof AttestationPathNotFoundError)) {
			throw error;
		}

		expect({
			error: {
				name: error.name,
				status: error.status,
				storePathHash: error.storePathHash
			},
			refs: await attestationReferenceRows(),
			objects: await casObjectRows()
		}).toStrictEqual({
			error: {
				name: AttestationPathNotFoundError.name,
				status: StatusCodes.NOT_FOUND,
				storePathHash: metadata.storePathHash
			},
			refs: [],
			objects: []
		});
	});

	it('garbage-collects expired pending attestation uploads and staging objects', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		const { token, metadata, bundle, digest } = await committedPathBundle();
		const existingPending = await pendingAttestationRows();
		const decision = attestationUploadDecisionSchema.parse(
			await negotiate(token, metadata.storePathHash, digest)
		);

		await env.BLOBS.put(decision.r2Key, bundle, { sha256: hexBytes(digest) });

		const expiredPending = {
			id: decision.uploadId,
			r2Key: decision.r2Key,
			expiresAt: '2026-01-01T00:15:00.000Z'
		};
		expect(await pendingAttestationRows()).toStrictEqual(
			[...existingPending, expiredPending].toSorted(compareById)
		);
		await expect(env.BLOBS.head(decision.r2Key)).resolves.not.toBeNull();

		vi.setSystemTime(new Date('2026-01-01T00:16:00.000Z'));

		await fixtureWorkerServer().runGarbageCollection();

		expect(await pendingAttestationRows()).toStrictEqual(existingPending);
		await expect(env.BLOBS.head(decision.r2Key)).resolves.toBeNull();
	});

	it('rejects an oversized bundle from metadata without filing a CAS object', async () => {
		const { token, metadata } = await committedPathBundle();
		const bundle = new Uint8Array(1024 * 1024 + 1);
		const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bundle));
		const decision = attestationUploadDecisionSchema.parse(
			await negotiate(token, metadata.storePathHash, digest)
		);

		await env.BLOBS.put(decision.r2Key, bundle, { sha256: hexBytes(digest) });

		const response = await authorisedWorkerFetch(
			`/cache/_default/attestations/${decision.uploadId}/attach`,
			token,
			{ method: 'POST' }
		);

		const staging = await env.BLOBS.head(decision.r2Key);
		const pending = await pendingAttestationRows();
		const body = orpcErrorBodyShape(await response.json());

		expect({
			status: response.status,
			body,
			refs: await attestationReferenceRows(),
			objects: await casObjectRows(),
			pending: pending.filter((row) => row.id === decision.uploadId),
			stagingPresent: staging !== null
		}).toStrictEqual({
			status: StatusCodes.REQUEST_TOO_LONG,
			body: {
				defined: false,
				code: 'PAYLOAD_TOO_LARGE',
				status: StatusCodes.REQUEST_TOO_LONG,
				data: undefined
			},
			refs: [],
			objects: [],
			pending: [],
			stagingPresent: false
		});
	});

	it('decides correctly when the bundle count exceeds one chunk width', async () => {
		// 91 distinct storePathHashes crosses the maxInClauseValues (90) boundary
		// in narInfoRowsFor, so this pins the chunked DO SQLite read in negotiate.
		const { token, metadata, bundle, digest } = await committedPathBundle();
		await attachBundle(token, metadata.storePathHash, bundle);

		const uncommittedHashes = Array.from({ length: 90 }, () =>
			uniqueStorePathHash()
		);
		const fakeDigest = sha256HexDigestSchema.parse('ab'.repeat(32));
		const bundles = [
			{ storePathHash: metadata.storePathHash, digest },
			...uncommittedHashes.map((storePathHash) => ({
				storePathHash,
				digest: fakeDigest
			}))
		];

		const response = await authorisedWorkerFetch(
			'/cache/_default/attestations',
			token,
			{
				body: JSON.stringify({ pushId: testPushId, bundles }),
				headers: { 'content-type': 'application/json' },
				method: 'POST'
			}
		);
		expect(response.status).toBe(StatusCodes.OK);
		const body = attestationNegotiateResponseSchema.parse(
			await response.json()
		);
		const decisions = body.bundles.map((b) =>
			attestationDecisionSchema.parse(b)
		);

		const skipDecisions = decisions.filter((d) => d.action === 'skip');
		const uploadDecisions = decisions.filter((d) => d.action === 'upload');

		expect({
			totalDecisions: decisions.length,
			skipCount: skipDecisions.length,
			uploadCount: uploadDecisions.length,
			skip: skipDecisions
		}).toStrictEqual({
			totalDecisions: 91,
			skipCount: 1,
			uploadCount: 90,
			skip: [{ action: 'skip', storePathHash: metadata.storePathHash, digest }]
		});
	});
});

async function committedPathBundle(): Promise<{
	readonly token: string;
	readonly nar: Awaited<ReturnType<typeof verifiableNar>>;
	readonly metadata: ReturnType<typeof uploadMetadata>;
	readonly bundle: Uint8Array;
	readonly digest: Sha256HexDigest;
}> {
	const token = await initialiseViaWorker();
	const nar = await verifiableNar('attestation-path');
	const storePathHash = uniqueStorePathHash();
	const metadata = uploadMetadata({
		storePathHash,
		narHash: nar.narHash,
		narSize: nar.narSize,
		fileHash: nar.fileHash,
		fileSize: nar.narBytes.byteLength
	});
	await pushPathThroughTenant(fixtureTenant, token, metadata, nar);
	const bundle = sigstoreBundleBytes(narDigestHex(nar.narHash));
	const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bundle));

	return { token, nar, metadata, bundle, digest };
}

function uniqueStorePathHash(): string {
	const digit =
		'0123456789abcdfghijklmnpqrsvwxyz'[storePathHashCursor.next % 32] ?? '0';
	storePathHashCursor.next += 1;

	return digit.repeat(32);
}

async function attachBundle(
	token: string,
	pathHash: string,
	bundle: Uint8Array
): Promise<unknown> {
	const response = await attachBundleResponse(token, pathHash, bundle);
	expect(response.status).toBe(StatusCodes.OK);

	return attestationAttachResponseSchema.parse(await response.json());
}

async function attachBundleResponse(
	token: string,
	pathHash: string,
	bundle: Uint8Array
): Promise<Response> {
	const digest = sha256HexDigestSchema.parse(await sha256HexBytes(bundle));
	const decision = attestationUploadDecisionSchema.parse(
		await negotiate(token, pathHash, digest)
	);

	await env.BLOBS.put(decision.r2Key, bundle, { sha256: hexBytes(digest) });

	return authorisedWorkerFetch(
		`/cache/_default/attestations/${decision.uploadId}/attach`,
		token,
		{ method: 'POST' }
	);
}

async function negotiate(
	token: string,
	pathHash: string,
	digest: Sha256HexDigest
): Promise<ParsedAttestationDecision> {
	const response = await authorisedWorkerFetch(
		'/cache/_default/attestations',
		token,
		{
			body: JSON.stringify({
				pushId: testPushId,
				bundles: [{ storePathHash: pathHash, digest }]
			}),
			headers: { 'content-type': 'application/json' },
			method: 'POST'
		}
	);
	expect(response.status).toBe(StatusCodes.OK);
	const body = attestationNegotiateResponseSchema.parse(await response.json());
	const [bundle] = z.tuple([attestationDecisionSchema]).parse(body.bundles);

	return bundle;
}

async function negotiateTenant(
	tenant: string,
	token: string,
	pathHash: string,
	digest: Sha256HexDigest
): Promise<ParsedAttestationDecision> {
	const pushId = await testPushIdFor(tenant);
	const response = await tenantFetch(
		tenant,
		'/cache/_default/attestations',
		token,
		{
			body: JSON.stringify({
				pushId,
				bundles: [{ storePathHash: pathHash, digest }]
			}),
			headers: { 'content-type': 'application/json' },
			method: 'POST'
		}
	);
	expect(response.status).toBe(StatusCodes.OK);
	const body = attestationNegotiateResponseSchema.parse(await response.json());
	const [bundle] = z.tuple([attestationDecisionSchema]).parse(body.bundles);

	return bundle;
}

async function pendingAttestationRowsFor(
	tenant: string
): Promise<{ id: string; r2Key: string; expiresAt: string }[]> {
	const rows = await runInDurableObject(
		testServerFor(tenant),
		(_instance, state) =>
			drizzle(state.storage, {
				schema: { pendingAttestations: schema.pendingAttestations }
			})
				.select({
					id: schema.pendingAttestations.id,
					r2Key: schema.pendingAttestations.r2Key,
					expiresAt: schema.pendingAttestations.expiresAt
				})
				.from(schema.pendingAttestations)
				.all()
	);

	return rows.toSorted(compareById);
}

async function pushPathThroughTenant(
	tenant: string,
	token: string,
	metadata: ReturnType<typeof uploadMetadata>,
	nar: Awaited<ReturnType<typeof verifiableNar>>
): Promise<void> {
	const pushId = await testPushIdFor(tenant);
	const negotiated = await tenantFetch(
		tenant,
		'/cache/_default/uploads',
		token,
		{
			body: JSON.stringify({
				pushId,
				paths: [uploadPathNegotiation(metadata)]
			}),
			headers: { 'content-type': 'application/json' },
			method: 'POST'
		}
	);
	expect(negotiated.status).toBe(StatusCodes.OK);
	const body = uploadNegotiateResponseSchema.parse(await negotiated.json());
	const [decision] = z.tuple([uploadActionDecisionSchema]).parse(body.uploads);

	await putNarBytes(decision.r2Key, nar);

	const committed = await commitUploadViaWorker(token, decision.uploadId, {
		tenant
	});
	expect(committed.status).toBe('committed');
}

function tenantFetch(
	tenant: string,
	path: string,
	token: string,
	init: RequestInit
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set('authorization', `Bearer ${token}`);

	return handlerFetch(`/t/${tenant}${path}`, { ...init, headers });
}

function eqStorePath(storePathHash: StorePathHash) {
	return and(
		eq(schema.narInfos.cache, ''),
		eq(schema.narInfos.storePathHash, storePathHash)
	);
}
