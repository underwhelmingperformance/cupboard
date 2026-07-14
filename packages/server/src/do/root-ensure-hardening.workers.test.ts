import { DEFAULT_CACHE, rootNameSchema } from '@cupboard/nix-store/scalars';
import { rootSetBodySchema } from '@cupboard/protocol/retention';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema.ts';
import {
	commitPath,
	currentServer,
	flakyR2,
	initialise,
	narBytes,
	resetTestServer,
	syntheticNarHash,
	uploadMetadata
} from '../test-support.ts';

import { AttestationCasService } from './attestation-cas-service.ts';
import { AttestationsService } from './attestations-service.ts';
import { CacheAdminService } from './cache-admin-service.ts';
import { ServerContext } from './context.ts';
import { DeletionQueueService } from './deletion-queue-service.ts';
import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import { RetentionService } from './retention-service.ts';
import { RootsService } from './roots-service.ts';
import { type CupboardServer } from './server.ts';

const rootName = rootNameSchema.parse('main');

// A `RootsService` wired over a fresh context sharing the live instance's
// storage, whose R2 head probe runs `onHead` first: the ensure path's
// off-gate identity snapshot settles servability with exactly one such probe
// per target, so this is a deterministic point to interleave a mutation
// between that snapshot and the gated write that revalidates it.
function rootsServiceWithHeadHook(
	instance: CupboardServer,
	state: DurableObjectState,
	onHead: () => void
): RootsService {
	const context = new ServerContext(state, {
		...instance.context.env,
		BLOBS: flakyR2(instance.context.env.BLOBS, { failures: 0, onMatch: onHead })
	});
	const attestationCas = new AttestationCasService(context);
	const narInfoObjects = new NarInfoObjectsService(context);
	const attestations = new AttestationsService(
		context,
		attestationCas,
		narInfoObjects
	);
	const deletionQueue = new DeletionQueueService(
		context,
		attestationCas,
		attestations,
		narInfoObjects
	);
	const cacheAdmin = new CacheAdminService(context, deletionQueue);
	const retention = new RetentionService(context);

	return new RootsService(context, cacheAdmin, retention, narInfoObjects);
}

// Fires `mutate` on the first head probe only, so a target that needs more
// than one (a multi-target root) settles the rest undisturbed.
function onceOnHead(mutate: () => void): () => void {
	let isFired = false;

	return () => {
		if (isFired) {
			return;
		}

		isFired = true;
		mutate();
	};
}

describe('root ensure hardening', () => {
	beforeEach(resetTestServer);

	it('answers build-required when a target is recommitted between the ensure probe and the gate', async () => {
		const token = await initialise();
		const committed = uploadMetadata({ fileSize: narBytes.byteLength });
		await commitPath(token, committed);

		const response = await runInDurableObject(
			currentServer(),
			(instance, state) => {
				const roots = rootsServiceWithHeadHook(
					instance,
					state,
					onceOnHead(() => {
						instance.context.db
							.update(schema.narInfos)
							.set({ narHash: syntheticNarHash(1) })
							.where(eq(schema.narInfos.storePathHash, committed.storePathHash))
							.run();
					})
				);

				return roots.ensureRoot(
					DEFAULT_CACHE,
					rootName,
					rootSetBodySchema.parse({ targets: [committed.storePath] })
				);
			}
		);

		expect(response).toStrictEqual({
			status: 'build-required',
			unavailable: [committed.storePath]
		});
	});

	it('still answers retained when the row is rewritten to the same identity between the probe and the gate', async () => {
		const token = await initialise();
		const committed = uploadMetadata({ fileSize: narBytes.byteLength });
		await commitPath(token, committed);

		const response = await runInDurableObject(
			currentServer(),
			(instance, state) => {
				const roots = rootsServiceWithHeadHook(
					instance,
					state,
					onceOnHead(() => {
						instance.context.db
							.update(schema.narInfos)
							.set({ narHash: committed.narHash })
							.where(eq(schema.narInfos.storePathHash, committed.storePathHash))
							.run();
					})
				);

				return roots.ensureRoot(
					DEFAULT_CACHE,
					rootName,
					rootSetBodySchema.parse({ targets: [committed.storePath] })
				);
			}
		);

		expect(response.status).toBe('retained');
		expect(
			response.status === 'retained' ? response.root.targets : undefined
		).toStrictEqual([
			{
				storePathHash: committed.storePathHash,
				storePath: committed.storePath,
				present: true
			}
		]);
	});

	it('lets setRoot succeed over a target recommitted between its probe and its gate, unlike ensure', async () => {
		const token = await initialise();
		const committed = uploadMetadata({ fileSize: narBytes.byteLength });
		await commitPath(token, committed);

		const summary = await runInDurableObject(
			currentServer(),
			(instance, state) => {
				const roots = rootsServiceWithHeadHook(
					instance,
					state,
					onceOnHead(() => {
						instance.context.db
							.update(schema.narInfos)
							.set({ narHash: syntheticNarHash(2) })
							.where(eq(schema.narInfos.storePathHash, committed.storePathHash))
							.run();
					})
				);

				return roots.setRoot(
					DEFAULT_CACHE,
					rootName,
					rootSetBodySchema.parse({ targets: [committed.storePath] })
				);
			}
		);

		expect(summary.targets).toStrictEqual([
			{
				storePathHash: committed.storePathHash,
				storePath: committed.storePath,
				present: true
			}
		]);
	});
});
