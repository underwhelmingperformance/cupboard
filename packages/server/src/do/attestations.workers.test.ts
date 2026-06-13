import { type AttestationNegotiateResponse } from '@cupboard/protocol/attestations';
import { type UploadNegotiateResponse } from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sha256HexBytes } from '../crypto/crypto.ts';
import * as schema from '../db/schema.ts';
import { attestationListObjectKey, casObjectKey } from '../http/http.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	attestationReferenceRows,
	authorisedWorkerFetch,
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
	testServerFor,
	uploadBlobMetadata,
	uploadMetadata,
	uploadPathNegotiation,
	verifiableNar
} from '../test-support.ts';

const predicateType = 'https://slsa.dev/provenance/v1';
let nextStorePathHash = 0;

describe('attestation attach and reads', () => {
	beforeEach(async () => {
		vi.useRealTimers();
		await resetTestServer();
		await clearBlobStorage();
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
			listBody: await list.json(),
			bundleStatus: bundleRead.status,
			bundleBytes: [...bundleBytes]
		}).toStrictEqual({
			attached: {
				storePathHash: metadata.storePathHash,
				digest,
				predicateType,
				status: 'attached'
			},
			listStatus: StatusCodes.OK,
			listBody: {
				attestations: [{ digest, predicateType, size: bundle.byteLength }]
			},
			bundleStatus: StatusCodes.OK,
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
		const body = await response.json<{ code: string; message: string }>();

		expect({
			status: response.status,
			code: body.code,
			message: body.message,
			refs: await attestationReferenceRows(),
			objects: await casObjectRows(),
			listStatus: list.status
		}).toStrictEqual({
			status: StatusCodes.UNPROCESSABLE_ENTITY,
			code: 'UNPROCESSABLE_CONTENT',
			message: 'Attestation subject digest does not match the committed NAR',
			refs: [],
			objects: [],
			listStatus: StatusCodes.NOT_FOUND
		});
	});

	it('rejects non-DSSE Sigstore content without filing a CAS object', async () => {
		const { token, metadata } = await committedPathBundle();
		const garbage = new TextEncoder().encode('not a sigstore bundle');

		const response = await attachBundleResponse(
			token,
			metadata.storePathHash,
			garbage
		);
		const body = await response.json<{ code: string; message: string }>();

		expect({
			status: response.status,
			code: body.code,
			message: body.message,
			refs: await attestationReferenceRows(),
			objects: await casObjectRows()
		}).toStrictEqual({
			status: StatusCodes.UNPROCESSABLE_ENTITY,
			code: 'UNPROCESSABLE_CONTENT',
			message: 'Attestation bundle is not JSON',
			refs: [],
			objects: []
		});
	});

	it('does not materialise a missing descriptor list during a read', async () => {
		const { token, metadata, bundle } = await committedPathBundle();
		await attachBundle(token, metadata.storePathHash, bundle);
		const key = attestationListObjectKey(fixtureTenant, metadata.storePathHash);
		await env.BLOBS.delete(key);
		const putSpy = vi.spyOn(env.BLOBS, 'put');
		const deleteSpy = vi.spyOn(env.BLOBS, 'delete');

		try {
			const list = await readFetch(`/attestations/${metadata.storePathHash}`);
			const head = await readFetch(`/attestations/${metadata.storePathHash}`, {
				method: 'HEAD'
			});

			expect({
				getStatus: list.status,
				headStatus: head.status,
				putCalls: putSpy.mock.calls.length,
				deleteCalls: deleteSpy.mock.calls.length
			}).toStrictEqual({
				getStatus: StatusCodes.NOT_FOUND,
				headStatus: StatusCodes.NOT_FOUND,
				putCalls: 0,
				deleteCalls: 0
			});
		} finally {
			putSpy.mockRestore();
			deleteSpy.mockRestore();
		}
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
			'write'
		);
		await pushPathThroughTenant('other', otherToken, metadata, nar);

		const own = await negotiate(token, metadata.storePathHash, digest);
		const other = await negotiateTenant(
			'other',
			otherToken,
			metadata.storePathHash,
			digest
		);

		expect({ own, other }).toStrictEqual({
			own: {
				action: 'skip',
				storePathHash: metadata.storePathHash,
				digest
			},
			other: {
				action: 'upload',
				storePathHash: metadata.storePathHash,
				digest,
				uploadId: expect.any(String) as string,
				r2Key: expect.any(String) as string,
				expiresAt: expect.any(String) as string
			}
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

		const body = await response.json<{ code: string; message: string }>();

		expect({
			status: response.status,
			code: body.code,
			message: body.message,
			refs: await attestationReferenceRows(),
			presence: await tenantCasBlobRows(),
			objects: await casObjectRows(),
			casObjectPresent: (await env.BLOBS.head(casObjectKey(digest))) !== null,
			usage: await tenantUsageRow()
		}).toStrictEqual({
			status: StatusCodes.INSUFFICIENT_STORAGE,
			code: 'INSUFFICIENT_STORAGE',
			message: 'This tenant is over its storage quota',
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
		const decision = await negotiate(token, metadata.storePathHash, digest);

		if (decision.action !== 'upload') {
			throw new Error('expected attestation upload decision');
		}

		const prepared = await authorisedWorkerFetch(
			`/cache/_default/attestations/${decision.uploadId}`,
			token,
			{ method: 'PUT' }
		);
		expect(prepared.status).toBe(StatusCodes.OK);
		await env.BLOBS.put(decision.r2Key, bundle, { sha256: hexBytes(digest) });

		const error = await runInDurableObject(
			fixtureWorkerServer(),
			async (instance) => {
				const services = instance as unknown as {
					readonly attestationCas: {
						measureStagedBundle: (
							key: string
						) => ReturnType<typeof instance.measureAttestationBundle>;
					};
					readonly attestations: {
						attach(cache: string, uploadId: string): Promise<unknown>;
					};
				};
				const measure = services.attestationCas.measureStagedBundle.bind(
					services.attestationCas
				);
				services.attestationCas.measureStagedBundle = async (key) => {
					const measured = await measure(key);
					instance.context.db
						.update(schema.narInfos)
						.set({ narHash: replacement.narHash, generation: 1 })
						.where(eqStorePath(metadata.storePathHash))
						.run();

					return measured;
				};

				try {
					await services.attestations.attach('', decision.uploadId);
				} catch (error_) {
					return error_;
				}

				throw new Error('expected stale attach to fail');
			}
		);

		expect(error).toBeInstanceOf(Error);
		expect({
			refs: await attestationReferenceRows(),
			objects: await casObjectRows()
		}).toStrictEqual({
			refs: [],
			objects: []
		});
	});

	it('garbage-collects expired pending attestation uploads and staging objects', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
		const { token, metadata, bundle, digest } = await committedPathBundle();
		const decision = await negotiate(token, metadata.storePathHash, digest);

		if (decision.action !== 'upload') {
			throw new Error('expected attestation upload decision');
		}

		const prepared = await authorisedWorkerFetch(
			`/cache/_default/attestations/${decision.uploadId}`,
			token,
			{ method: 'PUT' }
		);
		expect(prepared.status).toBe(StatusCodes.OK);
		await env.BLOBS.put(decision.r2Key, bundle, { sha256: hexBytes(digest) });

		expect(await pendingAttestationRows()).toContainEqual({
			id: decision.uploadId,
			r2Key: decision.r2Key,
			expiresAt: '2026-01-01T00:15:00.000Z'
		});
		await expect(env.BLOBS.head(decision.r2Key)).resolves.not.toBeNull();

		vi.setSystemTime(new Date('2026-01-01T00:16:00.000Z'));

		const gc = await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const server = instance as unknown as {
				readonly garbageCollection: {
					collectGarbage(): Promise<{
						readonly pendingUploadsDeleted: number;
						readonly pendingAttestationsDeleted: number;
						readonly rootsExpired: number;
						readonly pathsSwept: number;
						readonly narInfosDeleted: number;
					}>;
				};
			};

			return server.garbageCollection.collectGarbage();
		});

		expect(gc).toStrictEqual({
			pendingUploadsDeleted: 0,
			pendingAttestationsDeleted: 1,
			rootsExpired: 0,
			pathsSwept: 0,
			narInfosDeleted: 0
		});
		expect(await pendingAttestationRows()).not.toContainEqual({
			id: decision.uploadId,
			r2Key: decision.r2Key,
			expiresAt: '2026-01-01T00:15:00.000Z'
		});
		await expect(env.BLOBS.head(decision.r2Key)).resolves.toBeNull();
	});

	it('rejects an oversized bundle from metadata without filing a CAS object', async () => {
		const { token, metadata } = await committedPathBundle();
		const bundle = new Uint8Array(1024 * 1024 + 1);
		const digest = await sha256HexBytes(bundle);
		const decision = await negotiate(token, metadata.storePathHash, digest);

		if (decision.action !== 'upload') {
			throw new Error('expected attestation upload decision');
		}

		const prepared = await authorisedWorkerFetch(
			`/cache/_default/attestations/${decision.uploadId}`,
			token,
			{ method: 'PUT' }
		);
		expect(prepared.status).toBe(StatusCodes.OK);
		await env.BLOBS.put(decision.r2Key, bundle, { sha256: hexBytes(digest) });

		const response = await authorisedWorkerFetch(
			`/cache/_default/attestations/${decision.uploadId}/attach`,
			token,
			{ method: 'POST' }
		);

		const staging = await env.BLOBS.head(decision.r2Key);
		const pending = await pendingAttestationRows();
		const body = await response.json<{ code: string; message: string }>();

		expect({
			status: response.status,
			code: body.code,
			message: body.message,
			refs: await attestationReferenceRows(),
			objects: await casObjectRows(),
			pending: pending.filter((row) => row.id === decision.uploadId),
			stagingPresent: staging !== null
		}).toStrictEqual({
			status: StatusCodes.REQUEST_TOO_LONG,
			code: 'PAYLOAD_TOO_LARGE',
			message: 'Attestation bundle is too large',
			refs: [],
			objects: [],
			pending: [],
			stagingPresent: false
		});
	});
});

async function committedPathBundle(): Promise<{
	readonly token: string;
	readonly nar: Awaited<ReturnType<typeof verifiableNar>>;
	readonly metadata: ReturnType<typeof uploadMetadata>;
	readonly bundle: Uint8Array;
	readonly digest: string;
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
	const digest = await sha256HexBytes(bundle);

	return { token, nar, metadata, bundle, digest };
}

function uniqueStorePathHash(): string {
	const digit =
		'0123456789abcdfghijklmnpqrsvwxyz'[nextStorePathHash % 32] ?? '0';
	nextStorePathHash += 1;

	return digit.repeat(32);
}

async function attachBundle(
	token: string,
	pathHash: string,
	bundle: Uint8Array
): Promise<unknown> {
	const response = await attachBundleResponse(token, pathHash, bundle);
	expect(response.status).toBe(StatusCodes.OK);

	return response.json();
}

async function attachBundleResponse(
	token: string,
	pathHash: string,
	bundle: Uint8Array
): Promise<Response> {
	const digest = await sha256HexBytes(bundle);
	const decision = await negotiate(token, pathHash, digest);

	if (decision.action !== 'upload') {
		throw new Error('expected attestation upload decision');
	}

	const prepared = await authorisedWorkerFetch(
		`/cache/_default/attestations/${decision.uploadId}`,
		token,
		{ method: 'PUT' }
	);
	expect(prepared.status).toBe(StatusCodes.OK);
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
	digest: string
): Promise<AttestationNegotiateResponse['bundles'][number]> {
	const response = await authorisedWorkerFetch(
		'/cache/_default/attestations',
		token,
		{
			body: JSON.stringify({ bundles: [{ storePathHash: pathHash, digest }] }),
			headers: { 'content-type': 'application/json' },
			method: 'POST'
		}
	);
	expect(response.status).toBe(StatusCodes.OK);
	const body = await response.json<AttestationNegotiateResponse>();

	return body.bundles[0] ?? failDecision();
}

async function negotiateTenant(
	tenant: string,
	token: string,
	pathHash: string,
	digest: string
): Promise<AttestationNegotiateResponse['bundles'][number]> {
	const response = await tenantFetch(
		tenant,
		'/cache/_default/attestations',
		token,
		{
			body: JSON.stringify({ bundles: [{ storePathHash: pathHash, digest }] }),
			headers: { 'content-type': 'application/json' },
			method: 'POST'
		}
	);
	expect(response.status).toBe(StatusCodes.OK);
	const body = await response.json<AttestationNegotiateResponse>();

	return body.bundles[0] ?? failDecision();
}

async function pushPathThroughTenant(
	tenant: string,
	token: string,
	metadata: ReturnType<typeof uploadMetadata>,
	nar: Awaited<ReturnType<typeof verifiableNar>>
): Promise<void> {
	const negotiated = await tenantFetch(
		tenant,
		'/cache/_default/uploads',
		token,
		{
			body: JSON.stringify({ paths: [uploadPathNegotiation(metadata)] }),
			headers: { 'content-type': 'application/json' },
			method: 'POST'
		}
	);
	expect(negotiated.status).toBe(StatusCodes.OK);
	const body = await negotiated.json<UploadNegotiateResponse>();
	const decision = body.uploads[0] ?? failUploadDecision();

	if (decision.action !== 'upload') {
		throw new Error('expected upload decision');
	}

	const prepared = await tenantFetch(
		tenant,
		`/cache/_default/uploads/${decision.uploadId}`,
		token,
		{
			body: JSON.stringify(uploadBlobMetadata(metadata)),
			headers: { 'content-type': 'application/json' },
			method: 'PUT'
		}
	);
	expect(prepared.status).toBe(StatusCodes.OK);
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

function eqStorePath(storePathHash: string) {
	return and(
		eq(schema.narInfos.cache, ''),
		eq(schema.narInfos.storePathHash, storePathHash)
	);
}

function failDecision(): never {
	throw new Error('expected one attestation decision');
}

function failUploadDecision(): never {
	throw new Error('expected one upload decision');
}
