import {
	cacheGenerationSchema,
	narInfoGenerationSchema
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { authorizationDetailsSchema } from '@cupboard/protocol/grants';
import { publicationResultIdentitySchema } from '@cupboard/protocol/publication-manifests';
import { reuseViewNameSchema } from '@cupboard/protocol/reuse-views';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../db/schema.ts';
import {
	fixtureWorkerServer,
	initialiseViaWorker,
	namedCache,
	putWorkerTestCache,
	resetTestServer
} from '../test-support.ts';

import { NarInfoObjectsService } from './narinfo-objects-service.ts';
import { PublicationManifestAuthority } from './publication-manifest-authority.ts';
import { committedPath, setView } from './reuse-view-read.test-support.ts';

const destination = namedCache('manifest-destination');
const source = { cache: namedCache('manifest-source'), index: 0 };
const noRead = authorizationDetailsSchema.parse([
	{ type: 'cupboard_cache', cache: destination, actions: ['upload:commit'] }
]);
const readGrants = {
	direct: authorizationDetailsSchema.parse([
		{
			type: 'cupboard_cache',
			cache: source.cache,
			actions: ['cache:content-read']
		}
	])
};

async function fixture(access: 'public' | 'private' = 'public') {
	const path = await committedPath('manifest-authority', source.cache, {
		access
	});
	await putWorkerTestCache(await initialiseViaWorker(), destination, 'public');
	return runInDurableObject(fixtureWorkerServer(), (instance) => {
		const cache = instance.context.cacheRepository.require(source.cache);
		const row = instance.context.db
			.select()
			.from(schema.narInfos)
			.where(eq(schema.narInfos.cacheId, cache.id))
			.get();
		if (row === undefined) {
			throw new Error('Missing committed fixture');
		}
		return publicationResultIdentitySchema.parse({
			storePath: path.storePath,
			narHash: path.narHash,
			generation: row.generation,
			cache: source.cache,
			cacheGeneration: cache.generation
		});
	});
}

describe('PublicationManifestAuthority', () => {
	beforeEach(async () => {
		await resetTestServer();
		source.index += 1;
		source.cache = namedCache(`manifest-source-${String(source.index)}`);
		readGrants.direct = authorizationDetailsSchema.parse([
			{
				type: 'cupboard_cache',
				cache: source.cache,
				actions: ['cache:content-read']
			}
		]);
	});
	it('does not treat destination commit authority as private source access', async () => {
		const result = await fixture('private');
		await expect(
			runInDurableObject(fixtureWorkerServer(), (instance) =>
				new PublicationManifestAuthority(instance.context).resolveExact(
					destination,
					noRead,
					result
				)
			)
		).rejects.toMatchObject({ code: 'FORBIDDEN' });
	});
	it.each(['public', 'private'] as const)(
		'resolves a servable exact %s source and fences its local snapshot',
		async (access) => {
			const result = await fixture(access);
			await runInDurableObject(fixtureWorkerServer(), async (instance) => {
				const authority = new PublicationManifestAuthority(instance.context);
				const snapshot = authority.resolveExact(
					destination,
					access === 'public' ? noRead : readGrants.direct,
					result
				);
				await authority.requireServable(snapshot);
				expect(
					authority.revalidate(
						snapshot,
						access === 'public' ? noRead : readGrants.direct
					).result
				).toStrictEqual(result);
				instance.context.db
					.update(schema.narInfos)
					.set({
						generation: narInfoGenerationSchema.parse(result.generation + 1)
					})
					.where(eq(schema.narInfos.cacheId, snapshot.cache.id))
					.run();
				expect(() => authority.revalidate(snapshot, readGrants.direct)).toThrow(
					expect.objectContaining({ code: 'SERVICE_UNAVAILABLE' })
				);
			});
		}
	);
	it.each(['malformed', 'narHash', 'narUrl'] as const)(
		'never proves a served projection with a %s body despite current commit metadata',
		async (change) => {
			const result = await fixture();
			const key = await runInDurableObject(
				fixtureWorkerServer(),
				(instance) => {
					const cache = instance.context.cacheRepository.require(source.cache);
					return new NarInfoObjectsService(instance.context).objectKey(
						cache,
						StorePath.hash(result.storePath)
					);
				}
			);
			const object = await env.BLOBS.get(key);
			if (object === null) {
				throw new Error('Missing published projection');
			}
			const original = await object.text();
			const text =
				change === 'malformed'
					? 'not a narinfo'
					: change === 'narUrl'
						? original.replace(
								/^URL:.*$/mu,
								'URL: nar/not-the-canonical-object.nar.zst'
							)
						: original.replace(
								/^NarHash:.*$/mu,
								'NarHash: sha256:1023456789abcdfghijklmnpqrsvwxyz0123456789abcdfghijk'
							);
			await env.BLOBS.put(key, text, { customMetadata: object.customMetadata });
			await runInDurableObject(fixtureWorkerServer(), async (instance) => {
				const before = instance.context.db.select().from(schema.narInfos).all();
				const authority = new PublicationManifestAuthority(instance.context);
				const snapshot = authority.resolveExact(destination, noRead, result);
				await expect(authority.requireServable(snapshot)).rejects.toThrow();
				expect(
					instance.context.db.select().from(schema.narInfos).all()
				).toStrictEqual(before);
			});
			const unchanged = await env.BLOBS.get(key);
			expect(await unchanged?.text()).toBe(text);
		}
	);

	it('propagates R2 probe failures instead of repairing fabricated absence', async () => {
		const result = await fixture();
		await runInDurableObject(fixtureWorkerServer(), async (instance) => {
			const authority = new PublicationManifestAuthority(instance.context);
			const snapshot = authority.resolveExact(destination, noRead, result);
			const failure = new Error('provider get failed');
			const get = vi
				.spyOn(instance.context.env.BLOBS, 'get')
				.mockRejectedValueOnce(failure);
			const put = vi.spyOn(instance.context.env.BLOBS, 'put');
			try {
				await expect(authority.requireServable(snapshot)).rejects.toBe(failure);
				expect(put).not.toHaveBeenCalled();
			} finally {
				get.mockRestore();
				put.mockRestore();
			}
		});
	});

	it('rejects unknown and changed cache generations rather than returning a missing association', async () => {
		const result = await fixture();
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const authority = new PublicationManifestAuthority(instance.context);
			expect(() =>
				authority.resolveExact(destination, noRead, {
					...result,
					cacheGeneration: cacheGenerationSchema.parse(
						result.cacheGeneration + 1
					)
				})
			).toThrow(
				expect.objectContaining({ code: 'PUBLICATION_GENERATION_CONFLICT' })
			);
			expect(() =>
				authority.resolveExact(destination, noRead, {
					...result,
					cache: namedCache('manifest-absent')
				})
			).toThrow(
				expect.objectContaining({ code: 'PUBLICATION_GENERATION_CONFLICT' })
			);
		});
	});
	it('fences private view membership, access and revision', async () => {
		const result = await fixture('private');
		await setView(
			[{ kind: 'named', name: source.cache.name }],
			'manifest-view',
			'private'
		);
		const grants = authorizationDetailsSchema.parse([
			{
				type: 'cupboard_view',
				view: 'manifest-view',
				actions: ['view:content-read']
			}
		]);
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const authority = new PublicationManifestAuthority(instance.context);
			const view = reuseViewNameSchema.parse('manifest-view');
			const row = instance.context.db
				.select()
				.from(schema.reuseViews)
				.where(eq(schema.reuseViews.name, view))
				.get();
			if (row === undefined) {
				throw new Error('Missing view');
			}
			const selector = { view, expectedRevision: row.revision };
			const snapshot = authority.resolveExact(
				destination,
				grants,
				result,
				selector
			);
			expect(snapshot.sourceSelector).toStrictEqual(selector);
			instance.context.db
				.update(schema.reuseViews)
				.set({ access: 'public' })
				.where(eq(schema.reuseViews.name, view))
				.run();
			expect(() => authority.revalidate(snapshot, grants)).toThrow(
				expect.objectContaining({ code: 'PUBLICATION_SCOPE_CHANGED' })
			);
		});
	});
	it('rechecks private source readability on replay', async () => {
		const result = await fixture('private');
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const authority = new PublicationManifestAuthority(instance.context);
			const snapshot = authority.resolveExact(
				destination,
				readGrants.direct,
				result
			);
			expect(() => authority.revalidate(snapshot, noRead)).toThrow(
				expect.objectContaining({ code: 'FORBIDDEN' })
			);
		});
	});
	it('treats only an unfenced absent own destination as unavailable without registration', async () => {
		const result = await fixture();
		const absent = namedCache(`manifest-absent-${String(source.index)}`);
		const grants = authorizationDetailsSchema.parse([
			{ type: 'cupboard_cache', cache: absent, actions: ['upload:commit'] }
		]);
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const authority = new PublicationManifestAuthority(instance.context);
			const target = { storePath: result.storePath };
			expect(
				authority.findTarget(absent, grants, absent, target)
			).toBeUndefined();
			expect(() => authority.findTarget(absent, [], absent, target)).toThrow();
			expect(() =>
				authority.findTarget(
					absent,
					grants,
					absent,
					target,
					cacheGenerationSchema.parse(1)
				)
			).toThrow();
			expect(() =>
				authority.findTarget(absent, grants, absent, {
					...target,
					narHash: result.narHash
				})
			).toThrow();
			expect(() =>
				authority.findTarget(
					absent,
					grants,
					namedCache('absent-foreign'),
					target
				)
			).toThrow();
			expect(instance.context.cacheRepository.resolve(absent)).toBeUndefined();
		});
	});
});
