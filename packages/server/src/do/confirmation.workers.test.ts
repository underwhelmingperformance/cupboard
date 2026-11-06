import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	cacheGenerationSchema,
	cacheNameSchema,
	type CacheScope,
	graceSecondsSchema,
	narInfoGenerationSchema,
	rootNameSchema,
	storePathSchema,
	ttlSecondsSchema
} from '@cupboard/nix-store/scalars';
import { authorizationDetailsSchema } from '@cupboard/protocol/grants';
import {
	publicationCleanupMarginMs,
	publicationRecoveryMs,
	publicationStagingKey
} from '@cupboard/protocol/publication';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import {
	acceptCapabilitiesHeader,
	commitCapabilitiesValue,
	commitCapabilitiesValueWithCredit,
	publicationCapability,
	uploadCapabilitiesHeader,
	uploadConfirmPresentCapability,
	uploadConfirmPresentMaxRequestBytes,
	type UploadConfirmPresentRequest,
	uploadConfirmPresentResponseSchema,
	uploadNegotiateResponseSchema,
	uploadPlanResponseSchema
} from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { promoteVerifiedBlob } from '../blob/promote-blob.ts';
import * as d1Schema from '../db/d1-schema.ts';
import * as schema from '../db/schema.ts';
import {
	InvalidPushIdError,
	PublicationRecoveryExpiredError
} from '../errors.ts';
import { narInfoObjectKey, r2ObjectKeySchema } from '../http/http.ts';
import { defaultCommitEntryCreditBudget } from '../policy/commit-credit.ts';
import { fixtureTenant } from '../routing/tenant-routing.test-support.ts';
import {
	authorisedFetch,
	closeSessionAndWait,
	commitCreditAccept,
	commitPath,
	commitSharedPath,
	commitUpload,
	CommitVerdictError,
	currentNarObjectKey,
	currentServer,
	defaultCache,
	initialise,
	isNarInfoSignatureValid,
	issueServerSignedToken,
	namedCache,
	nixSha256Hash,
	openCommitSession,
	putNarBytes,
	resetTestServer,
	restartTestServers,
	testPushId,
	testPushIdFor,
	uploadMetadata,
	uploadPathNegotiation,
	verifiableNar,
	withoutAlarmArming
} from '../test-support.ts';

import { CacheRegistrationService } from './cache-registration-service.ts';
import { ConfirmationService } from './confirmation-service.ts';
import {
	confirmationIdentity,
	confirmationPruneLimit,
	ConfirmationStore
} from './confirmation-store.ts';
import type { ServerContext } from './context.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import { withOperationCost } from './operation-cost.ts';
import { PathReadAuthorityService } from './path-read-authority-service.ts';
import { PublicationManifestAvailabilityStore } from './publication-manifest-availability-store.ts';
import { RetentionService } from './retention-service.ts';
import { RootsService } from './roots-service.ts';
import { withRowBudget } from './row-budget.ts';

const runRoot = {
	name: rootNameSchema.parse('ci/run'),
	retention: {
		kind: 'duration' as const,
		seconds: ttlSecondsSchema.parse(3600)
	}
};
const metadata = uploadMetadata({ fileSize: 1 });
const missing = uploadMetadata({
	fileSize: 1,
	storePathHash: '22222222222222222222222222222222'
});

function body(
	overrides: Partial<UploadConfirmPresentRequest> = {}
): UploadConfirmPresentRequest {
	return {
		pushId: testPushId,
		cacheGeneration: cacheGenerationSchema.parse(1),
		paths: [uploadPathNegotiation(metadata)],
		...overrides
	};
}

function service(
	context: ServerContext,
	objects = new NarInfoObjectsService(context)
): ConfirmationService {
	const retention = new RetentionService(context);
	return new ConfirmationService(
		context,
		objects,
		retention,
		new RootsService(
			context,
			new CacheRegistrationService(context),
			retention,
			objects
		)
	);
}

function confirm(request = body(), scope: CacheScope = defaultCache()) {
	return runInDurableObject(currentServer(), (instance) =>
		service(instance.context).confirmPresent(scope, request)
	);
}

function send(token: string, request: unknown = body(), prefix = '') {
	return authorisedFetch(`${prefix}/uploads/confirm-present`, token, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(request)
	});
}

async function state() {
	return runInDurableObject(currentServer(), async (instance) => ({
		caches: instance.context.db.select().from(schema.cacheIdentities).all(),
		paths: instance.context.db.select().from(schema.narInfos).all(),
		receipts: instance.context.db
			.select()
			.from(schema.confirmationReceipts)
			.all(),
		grace: instance.context.db.select().from(schema.retentionGrace).all(),
		roots: instance.context.db.select().from(schema.retentionRoots).all(),
		targets: instance.context.db
			.select()
			.from(schema.retentionRootTargets)
			.all(),
		pending: instance.context.db.select().from(schema.pendingUploads).all(),
		publications: instance.context.db
			.select()
			.from(schema.publicationOperations)
			.all(),
		edges: await instance.context.d1
			.select()
			.from(d1Schema.blobReference)
			.all(),
		usage: await instance.context.d1.select().from(d1Schema.tenantUsage).all(),
		associations: instance.context.db
			.select()
			.from(schema.resultPublications)
			.all(),
		proofs: instance.context.db
			.select()
			.from(schema.resultPublicationMembers)
			.all(),
		manifests: instance.context.db
			.select()
			.from(schema.publicationManifests)
			.all(),
		members: instance.context.db
			.select()
			.from(schema.publicationManifestMembers)
			.all(),
		cardinalities: instance.context.db
			.select()
			.from(schema.publicationManifestCardinalities)
			.all(),
		operations: instance.context.db
			.select()
			.from(schema.publicationManifestOperations)
			.all(),
		pages: instance.context.db
			.select()
			.from(schema.publicationManifestOperationPages)
			.all()
	}));
}

async function configureGrace(seconds?: number): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		instance.context.db.delete(schema.retentionGrace).run();
		instance.context.db
			.update(schema.cacheIdentities)
			.set({
				graceSeconds:
					seconds === undefined ? sql`NULL` : graceSecondsSchema.parse(seconds),
				graceManaged: false
			})
			.run();
	});
}

async function publishNamed(token: string) {
	const created = await authorisedFetch('/caches/ci', token, {
		method: 'PUT',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ access: 'public', priority: 50 })
	});
	expect(created.status).toBe(200);
	const response = await authorisedFetch('/cache/ci/uploads', token, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			pushId: testPushId,
			paths: [uploadPathNegotiation(metadata)]
		})
	});
	const decision = uploadNegotiateResponseSchema.parse(await response.json())
		.uploads[0];
	if (decision?.action !== 'upload') {
		throw new Error('Expected a new upload');
	}
	await putNarBytes(decision.r2Key);
	await commitUpload(token, decision.uploadId, namedCache('ci'));
}

beforeEach(resetTestServer);

describe('confirmation authority and transport', () => {
	it.each(['', '/cache/ci'])(
		'confirms a served winner at %s without publication work',
		async (prefix) => {
			const token = await initialise();
			if (prefix === '') {
				await commitPath(token, metadata);
			} else {
				await publishNamed(token);
			}
			await configureGrace(3600);
			const before = await state();
			const row = before.paths[0];
			if (row === undefined) {
				throw new Error('Expected a published row');
			}
			const request = body({
				paths: [
					uploadPathNegotiation(missing),
					{ ...uploadPathNegotiation(metadata), narHash: nixSha256Hash('2') }
				],
				attachRoot: runRoot
			});
			const response = await send(token, request, prefix);
			expect({
				status: response.status,
				response: uploadConfirmPresentResponseSchema.parse(
					await response.json()
				)
			}).toStrictEqual({
				status: 200,
				response: {
					paths: [
						{
							storePathHash: missing.storePathHash,
							status: 'needs-publication'
						},
						{
							storePathHash: metadata.storePathHash,
							status: 'confirmed',
							narHash: row.narHash,
							generation: row.generation,
							grace: { retainUntil: '2026-01-01T01:00:00.000Z' }
						}
					]
				}
			});
			const after = await state();
			expect({
				paths: after.paths,
				pending: after.pending,
				publications: after.publications,
				edges: after.edges,
				usage: after.usage
			}).toStrictEqual({
				paths: before.paths,
				pending: before.pending,
				publications: before.publications,
				edges: before.edges,
				usage: before.usage
			});
			expect({
				receipts: after.receipts.length,
				roots: after.roots.length,
				targets: after.targets,
				grace: after.grace
			}).toStrictEqual({
				receipts: 1,
				roots: 1,
				targets: [
					{
						cacheId: row.cacheId,
						rootName: runRoot.name,
						storePathHash: metadata.storePathHash,
						storePath: metadata.storePath
					}
				],
				grace: [
					{
						cacheId: row.cacheId,
						storePathHash: metadata.storePathHash,
						retainUntil: '2026-01-01T01:00:00.000Z'
					}
				]
			});
			const receipt = after.receipts[0];
			expect(
				receipt === undefined
					? undefined
					: {
							acceptedAt: receipt.acceptedAt,
							recoveryDeadline: receipt.recoveryDeadline,
							graceDeadline: receipt.graceDeadline,
							pruneAfter: receipt.pruneAfter
						}
			).toStrictEqual({
				acceptedAt: '2026-01-01T00:00:00.000Z',
				recoveryDeadline: '2026-01-02T00:00:00.000Z',
				graceDeadline: '2026-01-01T01:00:00.000Z',
				pruneAfter: new Date(
					0xff_ff_ff_ff * 1000 + publicationCleanupMarginMs
				).toISOString()
			});
		}
	);

	it.each([
		{ actions: ['upload:confirm'], root: false, status: 403 },
		{ actions: ['upload:commit'], root: false, status: 403 },
		{ actions: ['upload:commit'], root: true, status: 200 }
	])(
		'authorises commit and root attachment separately: $actions/$root',
		async ({ actions, root, status }) => {
			await initialise();
			const grants = authorizationDetailsSchema.parse([
				{ type: 'cupboard_cache', cache: defaultCache(), actions },
				...(root
					? [
							{
								type: 'cupboard_cache',
								cache: defaultCache(),
								root: runRoot.name,
								actions: ['root:attach']
							}
						]
					: [])
			]);
			const token = await issueServerSignedToken(grants);
			const before = await state();
			const response = await send(token, body({ attachRoot: runRoot }));
			expect(response.status).toBe(status);
			if (status !== 200) {
				expect(await state()).toStrictEqual(before);
			}
		}
	);

	it('accepts commit authority without root authority when no root is requested, but never another cache', async () => {
		await initialise();
		const token = await issueServerSignedToken(
			authorizationDetailsSchema.parse([
				{
					type: 'cupboard_cache',
					cache: defaultCache(),
					actions: ['upload:commit']
				}
			])
		);
		const accepted = await send(token);
		expect(accepted.status).toBe(200);
		const before = await state();
		const refused = await send(token, body(), '/cache/ci');
		expect(refused.status).toBe(403);
		expect(await state()).toStrictEqual(before);
	});

	it('does not register absent caches and treats generation changes as request conflicts', async () => {
		const token = await initialise();
		const before = await state();
		const absent = await send(token, body(), '/cache/absent');
		expect(absent.status).toBe(404);
		const changed = body({ cacheGeneration: cacheGenerationSchema.parse(2) });
		const conflict = await send(token, changed);
		expect(conflict.status).toBe(409);
		expect(await state()).toStrictEqual(before);
	});

	it.each([
		undefined,
		publicationCapability,
		uploadConfirmPresentCapability,
		`${publicationCapability},${uploadConfirmPresentCapability}`
	])(
		'advertises independent accepted capability %s without changing credential semantics',
		async (accepted) => {
			const token = await initialise();
			const response = await authorisedFetch('/uploads/credential', token, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					...(accepted !== undefined && {
						[acceptCapabilitiesHeader]: accepted
					})
				},
				body: '{}'
			});
			expect({
				status: response.status,
				capability: response.headers.get(uploadCapabilitiesHeader) ?? undefined
			}).toStrictEqual({ status: 200, capability: accepted });
		}
	);

	it.each(
		[false, true].flatMap((hasCredit) =>
			[
				undefined,
				publicationCapability,
				uploadConfirmPresentCapability,
				`${publicationCapability},${uploadConfirmPresentCapability}`
			].map((accepted) => ({ hasCredit, accepted }))
		)
	)(
		'advertises confirmation in the commit handshake only when accepted: $accepted, credit=$hasCredit',
		async ({ hasCredit, accepted }) => {
			const token = await initialise();
			const capabilities = [
				...(hasCredit ? [commitCreditAccept] : []),
				...(accepted === undefined ? [] : [accepted])
			].join(',');
			const session = await openCommitSession(
				token,
				defaultCache(),
				capabilities || undefined
			);
			try {
				const legacy = hasCredit
					? commitCapabilitiesValueWithCredit(
							Math.floor(defaultCommitEntryCreditBudget / 2)
						)
					: commitCapabilitiesValue;
				const hasConfirmation =
					accepted?.split(',').includes(uploadConfirmPresentCapability) ??
					false;
				expect(session.capabilities).toBe(
					hasConfirmation
						? `${legacy},${uploadConfirmPresentCapability}`
						: legacy
				);
			} finally {
				await closeSessionAndWait(session.socket);
			}
		}
	);

	it.each([
		{
			name: 'duplicates',
			request: body({
				paths: [
					uploadPathNegotiation(metadata),
					uploadPathNegotiation(metadata)
				]
			}),
			status: 400
		},
		{ name: 'empty', request: body({ paths: [] }), status: 400 },
		{
			name: 'unknown fields',
			request: { ...body(), deadline: 100 },
			status: 400
		},
		{
			name: 'mismatched store hash',
			request: body({
				paths: [
					{
						...uploadPathNegotiation(metadata),
						storePathHash: missing.storePathHash
					}
				]
			}),
			status: 400
		},
		{
			name: 'too many paths',
			request: body({
				paths: Array.from({ length: 33 }, () => uploadPathNegotiation(metadata))
			}),
			status: 413
		}
	])('rejects $name before any mutation', async ({ request, status }) => {
		const token = await initialise();
		const before = await state();
		const response = await send(token, request);
		expect(response.status).toBe(status);
		expect(await state()).toStrictEqual(before);
	});

	it('enforces the raw frame limit but accepts metadata above the generic admin limit', async () => {
		const token = await initialise();
		const before = await state();
		const response = await authorisedFetch('/uploads/confirm-present', token, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body()).padEnd(
				uploadConfirmPresentMaxRequestBytes + 1,
				' '
			)
		});
		expect(response.status).toBe(413);
		expect(await state()).toStrictEqual(before);
		const padded = await authorisedFetch('/uploads/confirm-present', token, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body()).padEnd(
				uploadConfirmPresentMaxRequestBytes,
				' '
			)
		});
		expect(padded.status).toBe(200);
	});

	it('rejects an oversized canonical SQLite value before probing or changing retention', async () => {
		const token = await initialise();
		const paths = Array.from({ length: 32 }, (_, index) =>
			uploadPathNegotiation(
				uploadMetadata({
					fileSize: 1,
					storePathHash: index.toString(8).padStart(32, '0'),
					references: Array.from(
						{ length: 1000 },
						(_, reference) =>
							`${metadata.storePathHash}-${'a'.repeat(50)}${String(reference)}`
					)
				})
			)
		);
		const before = await state();
		const response = await send(token, body({ paths }));
		expect(response.status).toBe(413);
		expect(await state()).toStrictEqual(before);
	});
});

describe('confirmation availability and local-only race rechecks', () => {
	it('confirms a genuinely signed publication after canonical reference reordering without rewriting its bytes', async () => {
		await withoutAlarmArming(async () => {
			const token = await initialise();
			const path = uploadMetadata({
				fileSize: 1,
				references: [
					...metadata.references,
					'22222222222222222222222222222222-second'
				]
			});
			await commitPath(token, path);
			await configureGrace(3600);
			const before = await state();
			const row = before.paths[0];
			const key = narInfoObjectKey(
				fixtureTenant,
				path.storePathHash,
				defaultCache()
			);
			const published = await env.BLOBS.get(key);
			if (published === null || row === undefined) {
				throw new Error('Missing real publication');
			}
			const original = NarInfo.parse(await published.text());
			const reordered = NarInfo.fromFields({
				...original.toFields(),
				references: original.references.toReversed()
			});
			expect(reordered.fingerprint()).toBe(original.fingerprint());
			expect(reordered.references).not.toStrictEqual(original.references);
			const text = reordered.render();
			await env.BLOBS.put(key, text, {
				customMetadata: published.customMetadata,
				httpMetadata: published.httpMetadata
			});
			const request = body({ paths: [uploadPathNegotiation(path)] });
			expect(await confirm(request)).toStrictEqual({
				paths: [
					{
						storePathHash: path.storePathHash,
						status: 'confirmed',
						generation: row.generation,
						narHash: row.narHash,
						grace: { retainUntil: '2026-01-01T01:00:00.000Z' }
					}
				]
			});
			const unchanged = await env.BLOBS.get(key);
			expect({
				text: await unchanged?.text(),
				metadata: unchanged?.customMetadata,
				httpMetadata: unchanged?.httpMetadata
			}).toStrictEqual({
				text,
				metadata: published.customMetadata,
				httpMetadata: published.httpMetadata
			});
		});
	});

	it.each(['body', 'accepted-row'] as const)(
		'fences a local mutation during the %s fingerprint hash await',
		async (phase) => {
			await withoutAlarmArming(async () => {
				const token = await initialise();
				await commitPath(token, metadata);
				await configureGrace(3600);
				await runInDurableObject(currentServer(), async (instance) => {
					const original = crypto.subtle.digest.bind(crypto.subtle);
					let fingerprints = 0;
					const hashing = vi
						.spyOn(crypto.subtle, 'digest')
						.mockImplementation(async (algorithm, bytes) => {
							const digest = await original(algorithm, bytes);
							if (new TextDecoder().decode(bytes).startsWith('1;')) {
								fingerprints += 1;
								if (fingerprints === (phase === 'body' ? 1 : 2)) {
									instance.context.db
										.update(schema.narInfos)
										.set({ generation: narInfoGenerationSchema.parse(999) })
										.run();
								}
							}
							return digest;
						});
					try {
						expect(
							await service(instance.context).confirmPresent(
								defaultCache(),
								body({ attachRoot: runRoot })
							)
						).toStrictEqual({
							paths: [
								{
									storePathHash: metadata.storePathHash,
									status: 'needs-publication'
								}
							]
						});
						expect(fingerprints).toBe(phase === 'body' ? 1 : 2);
					} finally {
						hashing.mockRestore();
					}
				});
				const after = await state();
				expect({
					grace: after.grace,
					roots: after.roots,
					targets: after.targets,
					proofs: after.proofs,
					associations: after.associations
				}).toStrictEqual({
					grace: [],
					roots: [],
					targets: [],
					proofs: [],
					associations: []
				});
			});
		}
	);

	it.each(['narSize', 'references'] as const)(
		'refuses current signed fingerprint corruption in %s without confirmation or retention',
		async (change) => {
			await withoutAlarmArming(async () => {
				const token = await initialise();
				await commitPath(token, metadata);
				await configureGrace(3600);
				const before = await state();
				const row = before.paths[0];
				const key = narInfoObjectKey(
					fixtureTenant,
					metadata.storePathHash,
					defaultCache()
				);
				const published = await env.BLOBS.get(key);
				if (published === null || row === undefined) {
					throw new Error('Missing real publication');
				}
				const original = NarInfo.parse(await published.text());
				const publicKey = await runInDurableObject(
					currentServer(),
					(instance) =>
						instance.context.db.select().from(schema.signingKeys).get()
							?.publicKey
				);
				if (publicKey === undefined) {
					throw new Error('Missing signing key');
				}
				expect(await isNarInfoSignatureValid(original, publicKey)).toBe(true);
				expect(original.toFields()).toStrictEqual({
					...original.toFields(),
					storePath: row.storePath,
					narHash: row.narHash,
					narSize: row.narSize,
					references: JSON.parse(row.referencesJson) as unknown,
					sigs: JSON.parse(row.sigsJson) as unknown
				});
				expect(published.customMetadata).toStrictEqual({
					generation: String(row.generation),
					narHash: row.narHash,
					narUrl: original.url,
					signatureGeneration: String(
						row.pendingSignatureGeneration ?? row.signatureGeneration
					)
				});
				const changed = NarInfo.fromFields({
					...original.toFields(),
					...(change === 'narSize'
						? { narSize: original.narSize + 1 }
						: { references: ['22222222222222222222222222222222-changed'] })
				});
				expect(await isNarInfoSignatureValid(changed, publicKey)).toBe(false);
				expect(changed.sigs).toStrictEqual(original.sigs);
				const text = changed.render();
				await env.BLOBS.put(key, text, {
					customMetadata: published.customMetadata,
					httpMetadata: published.httpMetadata
				});
				await expect(
					confirm(body({ attachRoot: runRoot }))
				).rejects.toMatchObject({
					name: 'CorruptNarInfoProjectionError',
					status: 409,
					reason: 'invalid-publication'
				});
				expect(await state()).toStrictEqual(before);
				const unchanged = await env.BLOBS.get(key);
				expect({
					text: await unchanged?.text(),
					metadata: unchanged?.customMetadata,
					httpMetadata: unchanged?.httpMetadata
				}).toStrictEqual({
					text,
					metadata: published.customMetadata,
					httpMetadata: published.httpMetadata
				});
			});
		}
	);

	it.each([
		{ change: 'narSize', canonical: 'recovered' },
		{ change: 'references', canonical: 'recovered' },
		{ change: 'narSize', canonical: 'missing-state' },
		{ change: 'references', canonical: 'missing-state' },
		{ change: 'healthy', canonical: 'recovered' }
	] as const)(
		'checks $change fingerprint before stale-incarnation repair with $canonical canonical state',
		async ({ change, canonical }) => {
			await withoutAlarmArming(async () => {
				const token = await initialise();
				const nar = await verifiableNar(
					`stale-fingerprint-${change}-${canonical}`
				);
				const path = uploadMetadata({
					fileSize: nar.narBytes.byteLength,
					fileHash: nar.fileHash,
					narHash: nar.narHash,
					narSize: nar.narSize
				});
				await commitPath(token, path, nar);
				await configureGrace(3600);
				const key = narInfoObjectKey(
					fixtureTenant,
					path.storePathHash,
					defaultCache()
				);
				const published = await env.BLOBS.get(key);
				const accepted = await state();
				const row = accepted.paths[0];
				if (published === null || row === undefined) {
					throw new Error('Missing verified stale-incarnation fixture');
				}
				const originalText = await published.text();
				const original = NarInfo.parse(originalText);
				const publicKey = await runInDurableObject(
					currentServer(),
					(instance) =>
						instance.context.db.select().from(schema.signingKeys).get()
							?.publicKey
				);
				if (publicKey === undefined) {
					throw new Error('Missing publication signing key');
				}
				expect(await isNarInfoSignatureValid(original, publicKey)).toBe(true);
				expect(original.toFields()).toStrictEqual({
					...original.toFields(),
					storePath: row.storePath,
					narHash: row.narHash,
					narSize: row.narSize,
					references: JSON.parse(row.referencesJson) as unknown,
					sigs: JSON.parse(row.sigsJson) as unknown
				});
				expect(published.customMetadata).toStrictEqual({
					generation: String(row.generation),
					narHash: row.narHash,
					narUrl: original.url,
					signatureGeneration: String(
						row.pendingSignatureGeneration ?? row.signatureGeneration
					)
				});
				const oldNarKey = await currentNarObjectKey(path.narHash);
				expect(original.url).toBe(oldNarKey);
				await env.BLOBS.delete(oldNarKey);
				const stagingKey = r2ObjectKeySchema.parse(
					'staging/recover-fingerprint/upload'
				);
				await env.BLOBS.put(stagingKey, nar.narBytes);
				await runInDurableObject(currentServer(), (instance) =>
					promoteVerifiedBlob(
						instance.context.d1,
						instance.context.env.BLOBS,
						stagingKey,
						{ narHash: path.narHash, narSize: path.narSize },
						{ fileHash: nar.fileHash, fileSize: nar.narBytes.byteLength }
					)
				);
				const currentKey = await currentNarObjectKey(path.narHash);
				expect(currentKey).not.toBe(oldNarKey);
				if (canonical === 'missing-state') {
					await runInDurableObject(currentServer(), (instance) =>
						instance.context.d1
							.delete(d1Schema.blobState)
							.where(eq(d1Schema.blobState.narHash, path.narHash))
							.run()
					);
				}
				const changed = NarInfo.fromFields({
					...original.toFields(),
					...(change === 'narSize'
						? { narSize: original.narSize + 1 }
						: change === 'references'
							? { references: ['22222222222222222222222222222222-changed'] }
							: {})
				});
				expect(changed.sigs).toStrictEqual(original.sigs);
				expect(await isNarInfoSignatureValid(changed, publicKey)).toBe(
					change === 'healthy'
				);
				const text = changed.render();
				await env.BLOBS.put(key, text, {
					customMetadata: published.customMetadata,
					httpMetadata: published.httpMetadata
				});
				const canonicalState = () =>
					runInDurableObject(currentServer(), async (instance) => ({
						blobs: await instance.context.d1
							.select()
							.from(d1Schema.blobState)
							.all(),
						incarnations: await instance.context.d1
							.select()
							.from(d1Schema.objectIncarnation)
							.all()
					}));
				const before = {
					durable: await state(),
					canonical: await canonicalState()
				};
				const request = body({
					paths: [uploadPathNegotiation(path)],
					attachRoot: runRoot
				});
				if (change === 'healthy') {
					expect(await confirm(request)).toStrictEqual({
						paths: [
							{
								storePathHash: path.storePathHash,
								status: 'confirmed',
								generation: row.generation,
								narHash: row.narHash,
								grace: { retainUntil: '2026-01-01T01:00:00.000Z' }
							}
						]
					});
					const repaired = await env.BLOBS.get(key);
					const expectedText = NarInfo.fromFields({
						...original.toFields(),
						url: currentKey
					}).render();
					expect({
						text: await repaired?.text(),
						metadata: repaired?.customMetadata,
						httpMetadata: repaired?.httpMetadata
					}).toStrictEqual({
						text: expectedText,
						metadata: { ...published.customMetadata, narUrl: currentKey },
						httpMetadata: published.httpMetadata
					});
					const after = await state();
					expect(after.paths).toStrictEqual(before.durable.paths);
				} else {
					await expect(confirm(request)).rejects.toMatchObject({
						name: 'CorruptNarInfoProjectionError',
						status: 409,
						reason: 'invalid-publication'
					});
					expect({
						durable: await state(),
						canonical: await canonicalState()
					}).toStrictEqual(before);
					const unchanged = await env.BLOBS.get(key);
					expect({
						text: await unchanged?.text(),
						metadata: unchanged?.customMetadata,
						httpMetadata: unchanged?.httpMetadata
					}).toStrictEqual({
						text,
						metadata: published.customMetadata,
						httpMetadata: published.httpMetadata
					});
				}
				const canonicalObject = await env.BLOBS.get(currentKey);
				expect(
					canonicalObject === null
						? undefined
						: new Uint8Array(await canonicalObject.arrayBuffer())
				).toStrictEqual(nar.narBytes);
			});
		}
	);

	it.each(['unreadable', 'revoked'])(
		'refuses a %s reference even with intact canonical bytes and metadata',
		async (kind) => {
			const token = await initialise();
			await publishNamed(token);
			await configureGrace(3600);
			await runInDurableObject(currentServer(), async (instance) => {
				if (kind === 'unreadable') {
					await instance.context.d1
						.update(d1Schema.blobReference)
						.set({ readable: false })
						.run();
					return;
				}
				const row = instance.context.db.select().from(schema.narInfos).get();
				if (row === undefined) {
					throw new Error('Expected a row');
				}
				await instance.context.d1
					.insert(d1Schema.pathReadRevocation)
					.values({
						tenant: fixtureTenant,
						cacheKind: 'named',
						cacheName: cacheNameSchema.parse('ci'),
						cacheGeneration: cacheGenerationSchema.parse(1),
						storePathHash: metadata.storePathHash,
						generation: row.generation,
						isPending: true
					})
					.run();
			});
			expect(
				await confirm(body({ attachRoot: runRoot }), namedCache('ci'))
			).toStrictEqual({
				paths: [
					{ storePathHash: metadata.storePathHash, status: 'needs-publication' }
				]
			});
			const after = await state();
			expect({ grace: after.grace, roots: after.roots }).toStrictEqual({
				grace: [],
				roots: []
			});
		}
	);

	it.each(['canonical', 'edge'])(
		'returns a durable negative when the %s disappears despite local metadata',
		async (removed) => {
			const token = await initialise();
			await commitPath(token, metadata);
			await configureGrace(3600);
			if (removed === 'canonical') {
				await env.BLOBS.delete(await currentNarObjectKey(metadata.narHash));
			} else {
				await runInDurableObject(currentServer(), (instance) =>
					instance.context.d1.delete(d1Schema.blobReference).run()
				);
			}
			const result = await confirm(body({ attachRoot: runRoot }));
			expect(result).toStrictEqual({
				paths: [
					{ storePathHash: metadata.storePathHash, status: 'needs-publication' }
				]
			});
			const after = await state();
			expect({
				grace: after.grace,
				roots: after.roots,
				targets: after.targets,
				receipts: after.receipts.length,
				pending: after.pending,
				publications: after.publications
			}).toStrictEqual({
				grace: [],
				roots: [],
				targets: [],
				receipts: 1,
				pending: [],
				publications: []
			});
		}
	);

	it.each([
		'generation',
		'narHash',
		'delete',
		'epoch',
		'cacheGeneration',
		'close'
	])('rechecks %s after the actual servability probe', async (change) => {
		const token = await initialise();
		await commitPath(token, metadata);
		await configureGrace(3600);
		const probe = await runInDurableObject(currentServer(), (instance) => {
			const original =
				NarInfoObjectsService.prototype.servableNarInfoVersions.bind(
					new NarInfoObjectsService(instance.context)
				);
			return vi
				.spyOn(NarInfoObjectsService.prototype, 'servableNarInfoVersions')
				.mockImplementationOnce(async function (
					this: NarInfoObjectsService,
					cache,
					hashes
				) {
					const served = await original(cache, hashes);
					const database = instance.context.db;
					switch (change) {
						case 'generation': {
							database
								.update(schema.narInfos)
								.set({ generation: narInfoGenerationSchema.parse(999) })
								.run();

							break;
						}
						case 'narHash': {
							database
								.update(schema.narInfos)
								.set({ narHash: nixSha256Hash('2') })
								.run();

							break;
						}
						case 'delete': {
							database.delete(schema.narInfos).run();

							break;
						}
						case 'epoch': {
							database
								.update(schema.cacheIdentities)
								.set({ retentionEpoch: 1 })
								.run();

							break;
						}
						case 'cacheGeneration': {
							database
								.update(schema.cacheIdentities)
								.set({ generation: cacheGenerationSchema.parse(2) })
								.run();

							break;
						}
						case 'close': {
							database
								.insert(schema.managedCacheRetirements)
								.values({
									cacheId: cache.id,
									revision: 1,
									retirementStartedAt: isoTimestamp(new Date()),
									eligibleAfter: isoTimestamp(new Date()),
									nextCheckAt: isoTimestamp(new Date())
								})
								.run();

							break;
						}
						// No default
					}
					return served;
				});
		});
		try {
			const response = await send(token, body({ attachRoot: runRoot }));
			expect(response.status).toBe(
				change === 'cacheGeneration' || change === 'close' ? 409 : 200
			);
			if (response.status === 200) {
				expect(
					uploadConfirmPresentResponseSchema.parse(await response.json())
				).toStrictEqual({
					paths: [
						{
							storePathHash: metadata.storePathHash,
							status: 'needs-publication'
						}
					]
				});
			}
			const after = await state();
			expect(after.grace).toStrictEqual([]);
			expect(after.roots).toStrictEqual([]);
		} finally {
			probe.mockRestore();
		}
	});

	it.each([
		{ phase: 'initial', mutation: 'demote' },
		{ phase: 'initial', mutation: 'revoke' },
		{ phase: 'initial', mutation: 'unrelated-revoke' },
		{ phase: 'replay', mutation: 'demote' },
		{ phase: 'replay', mutation: 'revoke' }
	])(
		'fences $phase confirmation after fully drained $mutation',
		async ({ phase, mutation }) => {
			await withoutAlarmArming(async () => {
				const token = await initialise();
				await commitPath(token, metadata);
				if (mutation === 'unrelated-revoke') {
					await commitSharedPath(token, missing);
				}
				await configureGrace(3600);
				const request = body({ attachRoot: runRoot });
				if (phase === 'replay') {
					await confirm(request);
					vi.setSystemTime(Date.now() + 60_000);
				}
				const before = await state();
				const canonicalKey = await currentNarObjectKey(metadata.narHash);
				await runInDurableObject(currentServer(), async (instance) => {
					const context = instance.context;
					const cache = context.cacheRepository.require(defaultCache());
					const row = context.db
						.select()
						.from(schema.narInfos)
						.where(
							eq(
								schema.narInfos.storePathHash,
								mutation === 'unrelated-revoke'
									? missing.storePathHash
									: metadata.storePathHash
							)
						)
						.get();
					if (row === undefined) {
						throw new Error('Expected the accepted confirmation path');
					}
					const objects = new NarInfoObjectsService(context);
					const probe = objects.servableNarInfoVersions.bind(objects);
					let isProbed = false;
					const probes = vi
						.spyOn(objects, 'servableNarInfoVersions')
						.mockImplementationOnce(async (...arguments_) => {
							const served = await probe(...arguments_);
							isProbed = true;
							return served;
						});
					const enter = context.criticalSection.bind(context);
					const gate = vi
						.spyOn(context, 'criticalSection')
						.mockImplementation(async (run) => {
							if (isProbed) {
								isProbed = false;
								if (mutation === 'demote') {
									await env.BLOBS.delete(canonicalKey);
									await objects.demoteUnbacked(
										cache,
										row.storePathHash,
										row.narHash
									);
								} else {
									await new PathReadAuthorityService(context).revoke(cache, [
										row
									]);
								}
								const availability = new PublicationManifestAvailabilityStore(
									context.db
								);
								expect(availability.drain()).toBe(false);
								expect(
									context.db
										.select()
										.from(schema.publicationManifestAvailabilityIntents)
										.all()
								).toStrictEqual([]);
							}
							return enter(run);
						});
					try {
						await expect(
							service(context, objects).confirmPresent(defaultCache(), request)
						).rejects.toMatchObject({ status: 503 });
					} finally {
						gate.mockRestore();
						probes.mockRestore();
					}
				});
				const after = await state();
				expect({
					paths: after.paths,
					receipts: after.receipts,
					grace: after.grace,
					roots: after.roots,
					targets: after.targets,
					pending: after.pending,
					publications: after.publications,
					usage: after.usage
				}).toStrictEqual({
					paths: before.paths,
					receipts: before.receipts,
					grace: before.grace,
					roots: before.roots,
					targets: before.targets,
					pending: before.pending,
					publications: before.publications,
					usage: before.usage
				});
			});
		}
	);

	it('confirms a healthy winner when another NAR is missing from the batch', async () => {
		await withoutAlarmArming(async () => {
			const token = await initialise();
			const lost = await verifiableNar('confirmation-mixed-lost');
			const live = await verifiableNar('confirmation-mixed-live');
			const lostPath = uploadMetadata({
				name: 'lost',
				fileHash: lost.fileHash,
				narHash: lost.narHash,
				fileSize: lost.narBytes.byteLength,
				narSize: lost.narSize
			});
			const livePath = uploadMetadata({
				name: 'live',
				storePathHash: missing.storePathHash,
				fileHash: live.fileHash,
				narHash: live.narHash,
				fileSize: live.narBytes.byteLength,
				narSize: live.narSize
			});
			await commitPath(token, lostPath, lost);
			await commitPath(token, livePath, live);
			await configureGrace(3600);
			const before = await state();
			const row = before.paths.find(
				(path) => path.storePathHash === livePath.storePathHash
			);
			if (row === undefined) {
				throw new Error('Expected the healthy accepted path');
			}
			await env.BLOBS.delete(await currentNarObjectKey(lostPath.narHash));
			const request = body({
				paths: [
					uploadPathNegotiation(lostPath),
					uploadPathNegotiation(livePath)
				],
				attachRoot: runRoot
			});
			expect(await confirm(request)).toStrictEqual({
				paths: [
					{
						storePathHash: lostPath.storePathHash,
						status: 'needs-publication'
					},
					{
						storePathHash: livePath.storePathHash,
						status: 'confirmed',
						generation: row.generation,
						narHash: row.narHash,
						grace: { retainUntil: '2026-01-01T01:00:00.000Z' }
					}
				]
			});
			const after = await state();
			expect({
				paths: after.paths,
				pending: after.pending,
				publications: after.publications,
				edges: after.edges,
				usage: after.usage
			}).toStrictEqual({
				paths: before.paths,
				pending: before.pending,
				publications: before.publications,
				edges: before.edges,
				usage: before.usage
			});
			expect({ grace: after.grace, targets: after.targets }).toStrictEqual({
				grace: [
					{
						cacheId: row.cacheId,
						storePathHash: row.storePathHash,
						retainUntil: '2026-01-01T01:00:00.000Z'
					}
				],
				targets: [
					{
						cacheId: row.cacheId,
						rootName: runRoot.name,
						storePathHash: row.storePathHash,
						storePath: row.storePath
					}
				]
			});
		});
	});

	it('does not confirm another full store path with the same hash component', async () => {
		const token = await initialise();
		await commitPath(token, metadata);
		await configureGrace(3600);
		const different = uploadMetadata({ fileSize: 1, name: 'different-name' });
		const request = body({
			paths: [uploadPathNegotiation(different)],
			attachRoot: runRoot
		});
		const response = await confirm(request);
		expect(response).toStrictEqual({
			paths: [
				{ storePathHash: metadata.storePathHash, status: 'needs-publication' }
			]
		});
		const after = await state();
		expect({
			grace: after.grace,
			roots: after.roots,
			targets: after.targets
		}).toStrictEqual({ grace: [], roots: [], targets: [] });
	});

	it.each(['recorded', 'unrecorded'] as const)(
		'does not confirm a physically renamed row whose served narinfo still names the old path (%s metadata)',
		async (recording) => {
			await withoutAlarmArming(async () => {
				const token = await initialise();
				await commitPath(token, metadata);
				await configureGrace(3600);
				const key = narInfoObjectKey(
					fixtureTenant,
					metadata.storePathHash,
					defaultCache()
				);
				const published = await env.BLOBS.get(key);
				if (published === null) {
					throw new Error('Missing published narinfo');
				}
				const publishedBody = await published.text();
				if (recording === 'unrecorded') {
					await env.BLOBS.put(key, publishedBody);
				}
				const renamed = uploadMetadata({
					fileSize: 1,
					name: 'physically-renamed'
				});
				await runInDurableObject(currentServer(), (instance) => {
					instance.context.db
						.update(schema.narInfos)
						.set({ storePath: storePathSchema.parse(renamed.storePath) })
						.where(eq(schema.narInfos.storePathHash, metadata.storePathHash))
						.run();
					const availability = new PublicationManifestAvailabilityStore(
						instance.context.db
					);
					expect(availability.nextIntent(false)?.kind).toBe('local');
					expect(withRowBudget(() => availability.drain())).toBe(false);
					expect(availability.nextIntent(false)).toBeUndefined();
				});
				const before = await state();
				const request = body({
					paths: [uploadPathNegotiation(renamed)],
					attachRoot: runRoot
				});
				const result = await confirm(request);
				expect(result).toStrictEqual({
					paths: [
						{
							storePathHash: metadata.storePathHash,
							status: 'needs-publication'
						}
					]
				});
				const after = await state();
				expect({ ...after, receipts: [] }).toStrictEqual({
					...before,
					receipts: []
				});
				expect(after.receipts).toHaveLength(1);
				expect(
					JSON.parse(after.receipts[0]?.resultJson ?? 'null')
				).toStrictEqual(result);
				const saved = await state();
				expect(await confirm(request)).toStrictEqual(result);
				expect(await state()).toStrictEqual(saved);
				const unchanged = await env.BLOBS.get(key);
				expect(await unchanged?.text()).toBe(publishedBody);
			});
		}
	);

	it('rolls back grace, root binding, targets and receipt as one transaction', async () => {
		const token = await initialise();
		await commitPath(token, metadata);
		await configureGrace(3600);
		const before = await state();
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db.run(
				sql`CREATE TRIGGER reject_confirmation BEFORE INSERT ON confirmation_receipt BEGIN SELECT RAISE(ABORT, 'test receipt failure'); END`
			);
		});
		await expect(confirm(body({ attachRoot: runRoot }))).rejects.toThrow(
			'test receipt failure'
		);
		expect(await state()).toStrictEqual(before);
		await runInDurableObject(currentServer(), (instance) => {
			instance.context.db.run(sql`DROP TRIGGER reject_confirmation`);
		});
		const retried = await confirm(body({ attachRoot: runRoot }));
		expect(retried.paths[0]?.status).toBe('confirmed');
	});
});

describe('confirmation immutable receipts', () => {
	it('recovers a lost reply across restart without extending grace or root expiry', async () => {
		const token = await initialise();
		await commitPath(token, metadata);
		await configureGrace(3600);
		const request = body({ attachRoot: runRoot });
		const first = await confirm(request);
		const before = await state();
		await restartTestServers();
		vi.setSystemTime(new Date('2026-01-01T00:10:00.000Z'));
		expect(await confirm(request)).toStrictEqual(first);
		expect(await state()).toStrictEqual(before);
	});

	it('keeps negatives sticky and never binds a root for an all-negative page', async () => {
		const token = await initialise();
		const request = body({ attachRoot: runRoot });
		const first = await confirm(request);
		await commitPath(token, metadata);
		await configureGrace(3600);
		const before = await state();
		expect(await confirm(request)).toStrictEqual(first);
		expect(await state()).toStrictEqual(before);
		expect(first).toStrictEqual({
			paths: [
				{ storePathHash: metadata.storePathHash, status: 'needs-publication' }
			]
		});
		expect(before.roots).toStrictEqual([]);
	});

	it.each(['canonical', 'generation', 'narHash', 'epoch', 'root'])(
		'does not restore retention on replay after losing %s',
		async (change) => {
			const token = await initialise();
			await commitPath(token, metadata);
			await configureGrace(3600);
			const request = body({ attachRoot: runRoot });
			const first = await confirm(request);
			if (change === 'canonical') {
				await env.BLOBS.delete(await currentNarObjectKey(metadata.narHash));
			}
			await runInDurableObject(currentServer(), (instance) => {
				instance.context.db.delete(schema.retentionGrace).run();
				instance.context.db.delete(schema.retentionRootTargets).run();
				instance.context.db.delete(schema.retentionRoots).run();
				switch (change) {
					case 'generation': {
						instance.context.db
							.update(schema.narInfos)
							.set({ generation: narInfoGenerationSchema.parse(999) })
							.run();

						break;
					}
					case 'narHash': {
						instance.context.db
							.update(schema.narInfos)
							.set({ narHash: nixSha256Hash('2') })
							.run();

						break;
					}
					case 'epoch': {
						instance.context.db
							.update(schema.cacheIdentities)
							.set({ retentionEpoch: 1 })
							.run();

						break;
					}
					// No default
				}
			});
			const before = await state();
			const replay = await confirm(request);
			expect(replay).toStrictEqual(
				change === 'root'
					? first
					: {
							paths: [
								{
									storePathHash: metadata.storePathHash,
									status: 'needs-publication'
								}
							]
						}
			);
			expect(await state()).toStrictEqual(before);
		}
	);

	it.each([undefined, 0, 3600])(
		'preserves first grace with policy %s, and a new push is a new event',
		async (seconds) => {
			const token = await initialise();
			await commitPath(token, metadata);
			await configureGrace(seconds);
			const first = await confirm();
			const before = await state();
			const expectedGrace =
				seconds === undefined
					? {}
					: seconds === 0
						? { graceSeconds: 0 }
						: { retainUntil: '2026-01-01T01:00:00.000Z' };
			expect(first.paths[0]).toStrictEqual({
				storePathHash: metadata.storePathHash,
				status: 'confirmed',
				narHash: metadata.narHash,
				generation: before.paths[0]?.generation,
				grace: expectedGrace
			});
			vi.setSystemTime(new Date('2026-01-01T00:10:00.000Z'));
			expect(await confirm()).toStrictEqual(first);
			expect(await state()).toStrictEqual(before);
			await confirm(body({ pushId: await testPushIdFor(fixtureTenant, 1) }));
			const after = await state();
			expect(after.receipts.length).toBe(2);
			expect(after.grace.map((entry) => entry.retainUntil)).toStrictEqual(
				seconds === 3600 ? ['2026-01-01T01:10:00.000Z'] : []
			);
			expect(after.caches[0]?.graceManaged).toBe(seconds !== undefined);
		}
	);

	it('reports a later existing grace without shortening it', async () => {
		const token = await initialise();
		await commitPath(token, metadata);
		await configureGrace(3600);
		await runInDurableObject(currentServer(), (instance) => {
			new RetentionService(instance.context).extendGraceDeadlines(
				instance.context.cacheRepository.require(defaultCache()),
				[metadata.storePathHash],
				isoTimestamp(new Date('2026-02-01T00:00:00.000Z'))
			);
		});
		const first = await confirm();
		const before = await state();
		expect(first.paths[0]).toStrictEqual({
			storePathHash: metadata.storePathHash,
			status: 'confirmed',
			narHash: metadata.narHash,
			generation: before.paths[0]?.generation,
			grace: { retainUntil: '2026-02-01T00:00:00.000Z' }
		});
	});

	it('permits recovery after push expiry, refuses new pages and expires the recovery window', async () => {
		const token = await initialise();
		await commitPath(token, metadata);
		const expires = Math.floor(Date.now() / 1000) + 60;
		const request = body({
			pushId: await testPushIdFor(fixtureTenant, 2, expires)
		});
		const first = await confirm(request);
		const before = await state();
		vi.setSystemTime(new Date((expires + 1) * 1000));
		expect(await confirm(request)).toStrictEqual(first);
		await expect(
			confirm({ ...request, paths: [uploadPathNegotiation(missing)] })
		).rejects.toThrow('Push ID is not recognised');
		vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
		await expect(confirm(request)).rejects.toThrow(
			PublicationRecoveryExpiredError
		);
		expect(await state()).toStrictEqual(before);
		expect(before.receipts[0]?.pruneAfter).toBe(
			new Date(
				Date.parse('2026-01-01T00:00:00.000Z') +
					publicationRecoveryMs +
					publicationCleanupMarginMs
			).toISOString()
		);
	});

	it('concurrent identical pages install only one receipt and retention event', async () => {
		const token = await initialise();
		await commitPath(token, metadata);
		await configureGrace(3600);
		const bind = vi.spyOn(RootsService.prototype, 'bindRunRoot');
		const [first, second] = await Promise.all([
			confirm(body({ attachRoot: runRoot })),
			confirm(body({ attachRoot: runRoot }))
		]);
		expect(second).toStrictEqual(first);
		const after = await state();
		expect({
			receipts: after.receipts.length,
			binds: bind.mock.calls.length
		}).toStrictEqual({ receipts: 1, binds: 1 });
		bind.mockRestore();
	});

	it('bounds indexed cleanup and schedules a continuation until every due receipt is pruned', async () => {
		await initialise();
		await confirm();
		await runInDurableObject(currentServer(), async (instance) => {
			const receipt = instance.context.db
				.select()
				.from(schema.confirmationReceipts)
				.get();
			if (receipt === undefined) {
				throw new Error('Expected a receipt');
			}
			instance.context.db.delete(schema.confirmationReceipts).run();
			for (let index = 0; index < confirmationPruneLimit + 1; index += 1) {
				instance.context.db
					.insert(schema.confirmationReceipts)
					.values({
						...receipt,
						id: String(index),
						pruneAfter: isoTimestamp(new Date())
					})
					.run();
			}
			const store = new ConfirmationStore(instance.context);
			store.prune();
			expect(
				instance.context.db.select().from(schema.confirmationReceipts).all()
					.length
			).toBe(1);
			await instance.context.ctx.storage.deleteAlarm();
			const nextAttempt = Date.parse('2028-01-01T00:00:00.000Z');
			await store.armAlarm(nextAttempt);
			expect(await instance.context.ctx.storage.getAlarm()).toBe(nextAttempt);
			store.prune();
			expect(
				instance.context.db.select().from(schema.confirmationReceipts).all()
			).toStrictEqual([]);
		});
	});
});

it.each([
	{ isSharedNar: true, expectedHeads: 1 },
	{ isSharedNar: false, expectedHeads: 32 }
])(
	'confirms a maximum page with bounded cost and zero publication machinery (shared NAR: $isSharedNar)',
	async ({ isSharedNar, expectedHeads }) => {
		const token = await initialise();
		const fixtures = await Promise.all(
			Array.from({ length: 32 }, async (_, index) => {
				const nar = isSharedNar
					? undefined
					: await verifiableNar(`confirmation-max-${String(index)}`);
				const path = uploadMetadata({
					fileSize: nar?.narBytes.byteLength ?? 1,
					storePathHash: index.toString(8).padStart(32, '0'),
					...(nar !== undefined && {
						fileHash: nar.fileHash,
						narHash: nar.narHash,
						narSize: nar.narSize
					})
				});
				return { path, nar };
			})
		);
		for (const [index, { path, nar }] of fixtures.entries()) {
			if (index === 0 || !isSharedNar) {
				await commitPath(token, path, nar);
			} else {
				await commitSharedPath(token, path);
			}
		}
		const paths = fixtures.map((fixture) => fixture.path);
		await configureGrace(3600);
		const before = await state();
		const measured = await runInDurableObject(
			currentServer(),
			async (instance) => {
				let isInGate = false;
				const enter = instance.context.criticalSection.bind(instance.context);
				const gate = vi
					.spyOn(instance.context, 'criticalSection')
					.mockImplementation((run) =>
						enter(async () => {
							isInGate = true;
							try {
								return await run();
							} finally {
								isInGate = false;
							}
						})
					);
				const originalEnv = instance.context.env;
				const blobs = originalEnv.BLOBS;
				const head = blobs.head.bind(blobs);
				const get = blobs.get.bind(blobs);
				instance.context.env = {
					...originalEnv,
					BLOBS: new Proxy(blobs, {
						get(target, property, receiver) {
							if (property === 'head') {
								return (key: string) => {
									expect(isInGate).toBe(false);
									return head(key);
								};
							}
							if (property === 'get') {
								return (key: string) => {
									expect(isInGate).toBe(false);
									return get(key);
								};
							}
							const value: unknown = Reflect.get(target, property, receiver);
							return value;
						}
					})
				};
				const select = instance.context.d1.select.bind(instance.context.d1);
				const d1Guard = vi
					.spyOn(instance.context.d1, 'select')
					.mockImplementation((...arguments_) => {
						expect(isInGate).toBe(false);
						return select(...arguments_);
					});
				try {
					let cost;
					const transactions = vi.spyOn(instance.context.db, 'transaction');
					const response = await withOperationCost(
						'confirmation-test',
						() =>
							service(instance.context).confirmPresent(
								defaultCache(),
								body({
									paths: paths.map((path) => uploadPathNegotiation(path)),
									attachRoot: runRoot
								})
							),
						(settled) => {
							cost = settled;
						}
					);
					const transactionCount = transactions.mock.calls.length;
					transactions.mockRestore();
					return { response, cost, transactionCount };
				} finally {
					gate.mockRestore();
					instance.context.env = originalEnv;
					d1Guard.mockRestore();
				}
			}
		);
		expect(
			measured.response.paths.every((path) => path.status === 'confirmed')
		).toBe(true);
		expect(measured.response.paths.length).toBe(32);
		expect(measured.transactionCount).toBe(1);
		expect(measured.cost).toMatchObject({
			d1Calls: 4,
			d1RowsWritten: 0,
			r2Head: expectedHeads,
			r2Get: 32,
			r2Put: 0,
			r2Delete: 0,
			r2List: 0
		});
		const after = await state();
		expect({
			receipts: after.receipts.length,
			pending: after.pending,
			publications: after.publications,
			edges: after.edges,
			usage: after.usage
		}).toStrictEqual({
			receipts: 1,
			pending: [],
			publications: [],
			edges: before.edges,
			usage: before.usage
		});
	}
);

it('falls back to ordinary publication using the original planned operation when canonical bytes disappear', async () => {
	const token = await initialise();
	const nar = await verifiableNar('confirmation-fallback');
	const path = uploadMetadata({
		fileSize: nar.narBytes.byteLength,
		fileHash: nar.fileHash,
		narHash: nar.narHash,
		narSize: nar.narSize
	});
	await commitPath(token, path, nar);
	const response = await authorisedFetch('/uploads/plan', token, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			pushId: testPushId,
			paths: [uploadPathNegotiation(path)]
		})
	});
	const plan = uploadPlanResponseSchema.parse(await response.json());
	const planned = plan.uploads[0];
	if (planned === undefined) {
		throw new Error('Expected a planned publication');
	}
	await env.BLOBS.delete(await currentNarObjectKey(path.narHash));
	const request = body({
		cacheGeneration: plan.cacheGeneration,
		paths: [uploadPathNegotiation(path)]
	});
	expect(await confirm(request)).toStrictEqual({
		paths: [{ storePathHash: path.storePathHash, status: 'needs-publication' }]
	});
	const entry = {
		operationId: planned.operationId,
		cacheGeneration: plan.cacheGeneration,
		metadata: request.paths[0] ?? uploadPathNegotiation(path),
		blob: { fileHash: nar.fileHash, fileSize: nar.narBytes.byteLength }
	};
	await putNarBytes(
		publicationStagingKey(fixtureTenant, testPushId, entry.operationId),
		nar
	);
	const session = await openCommitSession(
		token,
		defaultCache(),
		publicationCapability
	);
	try {
		session.send({ op: 'publish-batch', pushId: testPushId, entries: [entry] });
		await session.nextFrame();
		await session.nextFrame();
	} finally {
		await closeSessionAndWait(session.socket);
	}
	// Restoring the same winner settles the old upload as absent; the existing
	// publication recovery re-admits the identical operation and serves it.
	await expect(commitUpload(token, entry.operationId)).rejects.toThrow(
		CommitVerdictError
	);
	const replay = await openCommitSession(
		token,
		defaultCache(),
		publicationCapability
	);
	try {
		replay.send({ op: 'publish-batch', pushId: testPushId, entries: [entry] });
		expect(await replay.nextFrame()).toStrictEqual({
			ev: 'publication-accepted',
			uploadId: entry.operationId
		});
		expect(await replay.nextFrame()).toStrictEqual({
			ev: 'settled',
			uploadId: entry.operationId,
			response: {
				storePathHash: path.storePathHash,
				narHash: path.narHash,
				status: 'already-present'
			},
			grace: {}
		});
	} finally {
		await closeSessionAndWait(replay.socket);
	}
	const after = await state();
	expect(
		after.publications.map((operation) => ({
			id: operation.id,
			state: operation.state
		}))
	).toStrictEqual([{ id: planned.operationId, state: 'servable' }]);
	// The old negative remains sticky; a new push can confirm the restored path.
	expect(await confirm(request)).toStrictEqual({
		paths: [{ storePathHash: path.storePathHash, status: 'needs-publication' }]
	});
	const fresh = await confirm({
		...request,
		pushId: await testPushIdFor(fixtureTenant, 6)
	});
	expect(fresh.paths[0]?.status).toBe('confirmed');
});

it('uses the existing recoverable narinfo repair without generating another publication', async () => {
	const token = await initialise();
	await commitPath(token, metadata);
	const before = await state();
	await runInDurableObject(currentServer(), async (instance) => {
		const objects = new NarInfoObjectsService(instance.context);
		const cache = instance.context.cacheRepository.require(defaultCache());
		await instance.context.env.BLOBS.delete(
			objects.objectKey(cache, metadata.storePathHash)
		);
	});
	const result = await confirm();
	expect(result.paths[0]?.status).toBe('confirmed');
	const after = await state();
	expect({
		paths: after.paths,
		pending: after.pending,
		publications: after.publications,
		edges: after.edges,
		usage: after.usage
	}).toStrictEqual({
		paths: before.paths,
		pending: before.pending,
		publications: before.publications,
		edges: before.edges,
		usage: before.usage
	});
});

it('binds the receipt to canonical full metadata, page order, cache and root parameters', async () => {
	await initialise();
	const request = body({
		paths: [
			{
				...uploadPathNegotiation(metadata),
				references: [...metadata.references, ...missing.references]
			},
			uploadPathNegotiation(missing)
		],
		attachRoot: runRoot
	});
	const first = await confirmationIdentity(
		fixtureTenant,
		defaultCache(),
		request
	);
	const reorderedReferences = {
		...request,
		paths: request.paths.map((path) => ({
			...path,
			references: [...path.references.toReversed(), ...path.references]
		}))
	};
	expect(
		await confirmationIdentity(
			fixtureTenant,
			defaultCache(),
			reorderedReferences
		)
	).toStrictEqual(first);
	const identities = await Promise.all([
		confirmationIdentity(fixtureTenant, namedCache('ci'), request),
		confirmationIdentity(fixtureTenant, defaultCache(), {
			...request,
			paths: [...request.paths].toReversed()
		}),
		confirmationIdentity(fixtureTenant, defaultCache(), {
			...request,
			attachRoot: { ...runRoot, retention: { kind: 'permanent' } }
		}),
		confirmationIdentity(fixtureTenant, defaultCache(), {
			...request,
			paths: request.paths.map((path) => ({
				...path,
				narSize: path.narSize + 1
			}))
		})
	]);
	expect(
		identities.every(
			(identity) =>
				identity.id !== first.id && identity.canonical !== first.canonical
		)
	).toBe(true);
});

it("never accepts another tenant's signed push ID", async () => {
	await initialise();
	const before = await state();
	const pushId = await testPushIdFor('other');
	await expect(confirm(body({ pushId }))).rejects.toThrow(InvalidPushIdError);
	expect(await state()).toStrictEqual(before);
});

it('leaves a receipt until its exact prune boundary and drains it through the alarm', async () => {
	await initialise();
	await confirm();
	await runInDurableObject(currentServer(), async (instance) => {
		const row = instance.context.db
			.select()
			.from(schema.confirmationReceipts)
			.get();
		if (row === undefined) {
			throw new Error('Expected a receipt');
		}
		const store = new ConfirmationStore(instance.context);
		const beforePrune = new Date(Date.parse(row.pruneAfter) - 1);
		store.prune(isoTimestamp(beforePrune));
		expect(store.get(row.id)).toStrictEqual(row);
		instance.context.db
			.update(schema.confirmationReceipts)
			.set({ pruneAfter: isoTimestamp(new Date()) })
			.where(eq(schema.confirmationReceipts.id, row.id))
			.run();
		await instance.alarm();
		expect(store.get(row.id)).toBeUndefined();
	});
});
