import { storePathSchema, ttlSecondsSchema } from '@cupboard/nix-store/scalars';
import {
	type AuthorizationDetails,
	authorizationDetailsSchema
} from '@cupboard/protocol/grants';
import { isoTimestamp } from '@cupboard/protocol/scalars';
import {
	type UploadAttachRootInput,
	uploadNegotiateResponseSchema
} from '@cupboard/protocol/upload';
import { runInDurableObject } from 'cloudflare:test';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema.ts';
import {
	authorisedFetch,
	currentServer,
	issueServerSignedToken,
	resetTestServer,
	testPushId,
	uploadMetadata,
	uploadPathNegotiation
} from '../test-support.ts';

const runRootName = 'ci/run-1';

// The shared test clock pins every negotiate to this instant, so a resolved
// expiry is the bind time plus the TTL, exactly.
const bindTime = '2026-01-01T00:00:00.000Z';
const oneHourLater = '2026-01-01T01:00:00.000Z';
const twoHoursLater = '2026-01-01T02:00:00.000Z';

/**
 * A CI-style push grant set: negotiate and commit on the default cache, plus
 * `root:attach` on one root selector when named. It authorises exactly the
 * push-with-run-root path, so tests can prove what a token without the attach
 * grant is refused.
 */
function pushGrants(attachRootSelector?: string): AuthorizationDetails {
	return authorizationDetailsSchema.parse([
		{
			type: 'cupboard_cache',
			actions: ['upload:negotiate', 'upload:commit'],
			cache: { kind: 'default' }
		},
		...(attachRootSelector === undefined
			? []
			: [
					{
						type: 'cupboard_cache',
						actions: ['root:attach'],
						cache: { kind: 'default' },
						root: attachRootSelector
					}
				])
	]);
}

function negotiate(
	token: string,
	paths: readonly ReturnType<typeof uploadMetadata>[],
	attachRoot?: UploadAttachRootInput
): Promise<Response> {
	return authorisedFetch('/uploads', token, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			pushId: testPushId,
			paths: paths.map((path) => uploadPathNegotiation(path)),
			...(attachRoot !== undefined && { attachRoot })
		})
	});
}

// The nullable columns are read back as `undefined` so an expectation can
// state their absence the way the rest of the suite does.
async function retentionRootRows(): Promise<readonly unknown[]> {
	return runInDurableObject(currentServer(), (instance) =>
		instance.context.db
			.select({
				cacheId: schema.retentionRoots.cacheId,
				name: schema.retentionRoots.name,
				expiresAt: schema.retentionRoots.expiresAt,
				createdAt: schema.retentionRoots.createdAt,
				updatedAt: schema.retentionRoots.updatedAt
			})
			.from(schema.retentionRoots)
			.all()
			.map(({ cacheId, ...row }) => ({
				...row,
				cache: instance.context.cacheRepository.scopeForId(cacheId),
				expiresAt: row.expiresAt ?? undefined
			}))
	);
}

async function plannedUploadRows(): Promise<
	readonly { id: string; attachRootName: string | undefined }[]
> {
	return runInDurableObject(currentServer(), (instance) =>
		instance.context.db
			.select({
				id: schema.pendingUploads.id,
				attachRootName: schema.pendingUploads.attachRootName
			})
			.from(schema.pendingUploads)
			.all()
			.map((row) => ({
				id: row.id,
				attachRootName: row.attachRootName ?? undefined
			}))
	);
}

async function addRootNamePolicy(
	pattern: string,
	ttlSeconds: number
): Promise<void> {
	await runInDurableObject(currentServer(), (instance) => {
		instance.context.db
			.insert(schema.retentionPolicies)
			.values({
				id: 'policy-1',
				kind: 'root-name-prefix',
				rootNamePrefix: pattern,
				defaultTtlSeconds: ttlSecondsSchema.parse(ttlSeconds),
				createdAt: isoTimestamp(new Date())
			})
			.run();
	});
}

describe('negotiate binds the run root', () => {
	beforeEach(resetTestServer);

	it('creates the root, resolves its expiry, and stamps every planned row', async () => {
		const token = await issueServerSignedToken(pushGrants('ci/'));
		const paths = [
			uploadMetadata({ storePathHash: 'a'.repeat(32), fileSize: 1 }),
			uploadMetadata({ storePathHash: 'b'.repeat(32), fileSize: 1 })
		];

		const response = await negotiate(token, paths, {
			name: runRootName,
			ttlSeconds: 3600
		});

		expect(response.status).toBe(StatusCodes.OK);
		const negotiated = uploadNegotiateResponseSchema.parse(
			await response.json()
		);
		const uploadIds = negotiated.uploads.flatMap((decision) =>
			decision.action === 'skip' ? [] : [decision.uploadId]
		);

		expect({
			roots: await retentionRootRows(),
			planned: await plannedUploadRows()
		}).toStrictEqual({
			roots: [
				{
					cache: { kind: 'default' },
					name: runRootName,
					expiresAt: oneHourLater,
					createdAt: bindTime,
					updatedAt: bindTime
				}
			],
			planned: uploadIds.map((id) => ({ id, attachRootName: runRootName }))
		});
	});

	it.each([
		{
			name: 'a longer ttl extends the expiry',
			laterTtlSeconds: 7200,
			expiresAt: twoHoursLater
		},
		{
			name: 'a shorter ttl leaves the expiry alone',
			laterTtlSeconds: 60,
			expiresAt: oneHourLater
		}
	])('$name', async ({ laterTtlSeconds, expiresAt }) => {
		const token = await issueServerSignedToken(pushGrants('ci/'));
		const first = await negotiate(
			token,
			[uploadMetadata({ storePathHash: 'a'.repeat(32), fileSize: 1 })],
			{ name: runRootName, ttlSeconds: 3600 }
		);
		const second = await negotiate(
			token,
			[uploadMetadata({ storePathHash: 'b'.repeat(32), fileSize: 1 })],
			{ name: runRootName, ttlSeconds: laterTtlSeconds }
		);

		expect({
			first: first.status,
			second: second.status,
			roots: await retentionRootRows()
		}).toStrictEqual({
			first: StatusCodes.OK,
			second: StatusCodes.OK,
			roots: [
				{
					cache: { kind: 'default' },
					name: runRootName,
					expiresAt,
					createdAt: bindTime,
					updatedAt: bindTime
				}
			]
		});
	});

	it.each([
		{ name: 'permanent with no matching policy', expiresAt: undefined },
		{
			name: 'the matching root-name policy ttl',
			policyTtlSeconds: 7200,
			expiresAt: twoHoursLater
		}
	])(
		'resolves an absent ttl to $name',
		async ({ policyTtlSeconds, expiresAt }) => {
			if (policyTtlSeconds !== undefined) {
				await addRootNamePolicy('ci/', policyTtlSeconds);
			}

			const token = await issueServerSignedToken(pushGrants('ci/'));
			const response = await negotiate(
				token,
				[uploadMetadata({ storePathHash: 'a'.repeat(32), fileSize: 1 })],
				{ name: runRootName }
			);

			expect({
				status: response.status,
				roots: await retentionRootRows()
			}).toStrictEqual({
				status: StatusCodes.OK,
				roots: [
					{
						cache: { kind: 'default' },
						name: runRootName,
						expiresAt,
						createdAt: bindTime,
						updatedAt: bindTime
					}
				]
			});
		}
	);

	it.each([
		{ name: 'no root grant at all', grants: pushGrants() },
		{ name: 'a grant naming a different root', grants: pushGrants('other') },
		{
			name: 'a root:set grant on the root, which does not imply attach',
			grants: authorizationDetailsSchema.parse([
				{
					type: 'cupboard_cache',
					actions: ['upload:negotiate', 'upload:commit'],
					cache: { kind: 'default' }
				},
				{
					type: 'cupboard_cache',
					actions: ['root:set'],
					cache: { kind: 'default' },
					root: runRootName
				}
			])
		}
	])('refuses a token with $name before planning', async ({ grants }) => {
		const token = await issueServerSignedToken(grants);

		const response = await negotiate(
			token,
			[uploadMetadata({ storePathHash: 'a'.repeat(32), fileSize: 1 })],
			{ name: runRootName, ttlSeconds: 3600 }
		);

		expect({
			status: response.status,
			roots: await retentionRootRows(),
			planned: await plannedUploadRows()
		}).toStrictEqual({
			status: StatusCodes.FORBIDDEN,
			roots: [],
			planned: []
		});
	});

	it('leaves the column null and creates no root without attachRoot', async () => {
		const token = await issueServerSignedToken(pushGrants());

		const response = await negotiate(token, [
			uploadMetadata({ storePathHash: 'a'.repeat(32), fileSize: 1 })
		]);

		expect(response.status).toBe(StatusCodes.OK);
		const negotiated = uploadNegotiateResponseSchema.parse(
			await response.json()
		);
		const uploadIds = negotiated.uploads.flatMap((decision) =>
			decision.action === 'skip' ? [] : [decision.uploadId]
		);

		expect({
			roots: await retentionRootRows(),
			planned: await plannedUploadRows()
		}).toStrictEqual({
			roots: [],
			planned: uploadIds.map((id) => ({ id, attachRootName: undefined }))
		});
	});

	it('validates every store path before binding the run root', async () => {
		const token = await issueServerSignedToken(pushGrants(runRootName));
		const original = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			fileSize: 1
		});
		const metadata = {
			...original,
			storePath: storePathSchema.parse(
				'/other/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-first'
			)
		};

		const response = await negotiate(token, [metadata], {
			name: runRootName,
			ttlSeconds: 3600
		});

		expect({
			status: response.status,
			roots: await retentionRootRows(),
			planned: await plannedUploadRows()
		}).toStrictEqual({
			status: StatusCodes.BAD_REQUEST,
			roots: [],
			planned: []
		});
	});
});
