import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	nixSha256HashSchema,
	referencesSchema,
	storePathHashSchema,
	storePathSchema
} from '@cupboard/nix-store/scalars';
import {
	cacheMetadataMaxCandidateBytes,
	cacheMetadataMaxNarInfoBytes,
	cacheMetadataMaxPaths
} from '@cupboard/protocol/cache-metadata';
import { reuseViewNameSchema } from '@cupboard/protocol/reuse-views';
import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { and, eq, getTableColumns, sql } from 'drizzle-orm';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../db/schema.ts';
import {
	MetadataCandidateBudgetExceededError,
	MetadataNarInfoInvalidError,
	MetadataNarInfoTooLargeError
} from '../errors.ts';
import { rootLogger } from '../observability/logging.ts';
import {
	currentNarObjectKey,
	fixtureWorkerServer,
	namedCache,
	readFetch,
	resetTestServer
} from '../test-support.ts';

import { ReuseViewLookupService } from './reuse-view-lookup-service.ts';
import {
	committedPath,
	insertAgreeingCopy,
	lookupPath,
	removeView,
	setView
} from './reuse-view-read.test-support.ts';

const view = reuseViewNameSchema.parse('reuse');

describe('reuse-view metadata rendering', () => {
	beforeEach(resetTestServer);
	beforeEach(() => removeView());

	it('renders complete signature unions and misses in request order', async () => {
		const first = await committedPath('metadata-first', namedCache('pr-1'), {
			storePathHash: '2'.repeat(32)
		});
		const second = await committedPath('metadata-second', namedCache('pr-2'), {
			storePathHash: '3'.repeat(32)
		});
		await insertAgreeingCopy(namedCache('pr-3'), first.storePathHash);
		await setView([{ kind: 'prefix', prefix: 'pr-' }]);
		await runInDurableObject(fixtureWorkerServer(), (instance) => {
			const cache = instance.context.cacheRepository.require(
				namedCache('pr-3')
			);
			instance.context.db
				.update(schema.narInfos)
				.set({ sigsJson: JSON.stringify(['extra-1:YW5vdGhlciBzaWduYXR1cmU=']) })
				.where(eq(schema.narInfos.cacheId, cache.id))
				.run();
		});
		const firstResponse = await readFetch(lookupPath(first.storePathHash));
		const secondResponse = await readFetch(lookupPath(second.storePathHash));
		const firstNarInfo = await firstResponse.text();
		const secondNarInfo = await secondResponse.text();
		const missing = storePathSchema.parse(
			`/nix/store/${'0'.repeat(32)}-absent`
		);
		const storePaths = [
			storePathSchema.parse(second.storePath),
			missing,
			storePathSchema.parse(first.storePath)
		];
		const result = await runInDurableObject(
			fixtureWorkerServer(),
			async (instance) => {
				const batch = await new ReuseViewLookupService(
					instance.context
				).metadata(rootLogger(), view, 'public', storePaths);

				if (batch.kind !== 'ready') {
					throw new Error('the metadata view must be ready');
				}

				return { access: batch.access, entries: [...batch.entries] };
			}
		);

		expect(result).toStrictEqual({
			access: 'public',
			entries: [
				{
					storePath: second.storePath,
					status: 'found',
					narinfo: secondNarInfo
				},
				{ storePath: missing, status: 'missing' },
				{ storePath: first.storePath, status: 'found', narinfo: firstNarInfo }
			]
		});
	});

	it('verifies alternatives beyond sixteen distinct NARs before deciding availability', async () => {
		const paths = [];

		for (let index = 0; index < 17; index += 1) {
			const path = await committedPath(
				`metadata-alternative-${String(index)}`,
				namedCache(`wide-${String(index)}`),
				{
					storePathHash: '7'.repeat(32)
				}
			);
			paths.push(path);

			if (index < 16) {
				await env.BLOBS.delete(
					await currentNarObjectKey(nixSha256HashSchema.parse(path.narHash))
				);
			}
		}

		const last = paths.at(-1);

		if (last === undefined) {
			throw new Error('the alternatives must include one present NAR');
		}

		await setView([{ kind: 'named', name: 'wide-16' }]);
		const response = await readFetch(lookupPath(last.storePathHash));
		const expected = await response.text();
		await setView([{ kind: 'prefix', prefix: 'wide-' }]);
		const result = await runInDurableObject(
			fixtureWorkerServer(),
			async (instance) => {
				const batch = await new ReuseViewLookupService(
					instance.context
				).metadata(rootLogger(), view, 'public', [
					storePathSchema.parse(last.storePath)
				]);

				if (batch.kind !== 'ready') {
					throw new Error('the metadata view must be ready');
				}

				return [...batch.entries];
			}
		);

		expect(result).toStrictEqual([
			{ storePath: last.storePath, status: 'found', narinfo: expected }
		]);
	});

	it('rejects a narinfo whose full path differs from the requested path', async () => {
		const path = await committedPath('metadata-identity', namedCache('pr-1'), {
			storePathHash: '4'.repeat(32)
		});
		await setView([{ kind: 'named', name: 'pr-1' }]);
		const requested = storePathSchema.parse(
			`/nix/store/${path.storePathHash}-different`
		);
		await runInDurableObject(fixtureWorkerServer(), async (instance) => {
			const batch = await new ReuseViewLookupService(instance.context).metadata(
				rootLogger(),
				view,
				'public',
				[requested]
			);

			if (batch.kind !== 'ready') {
				throw new Error('the metadata view must be ready');
			}

			expect(() => [...batch.entries]).toThrow(MetadataNarInfoInvalidError);
		});
	});

	it.each([
		{
			field: 'references',
			hash: '9',
			stored: { referencesJson: '{invalid' },
			error: MetadataNarInfoInvalidError
		},
		{
			field: 'signatures',
			hash: 'a',
			stored: { sigsJson: '{"invalid":true}' },
			error: MetadataNarInfoInvalidError
		},
		{
			field: 'NAR size',
			hash: 'b',
			stored: { narSize: -1 },
			error: MetadataNarInfoInvalidError
		},
		{
			field: 'oversized signatures',
			hash: 'c',
			stored: {
				sigsJson: JSON.stringify(['x'.repeat(cacheMetadataMaxNarInfoBytes)])
			},
			error: MetadataNarInfoTooLargeError
		}
	])(
		'returns the typed metadata error for invalid stored $field',
		async ({ field, hash, stored, error }) => {
			const path = await committedPath(
				`metadata-invalid-${field}`,
				namedCache('invalid'),
				{ storePathHash: hash.repeat(32) }
			);
			await setView([{ kind: 'named', name: 'invalid' }]);
			await runInDurableObject(fixtureWorkerServer(), async (instance) => {
				instance.context.db
					.update(schema.narInfos)
					.set(stored)
					.where(
						eq(
							schema.narInfos.storePathHash,
							storePathHashSchema.parse(path.storePathHash)
						)
					)
					.run();
				const batch = await new ReuseViewLookupService(
					instance.context
				).metadata(rootLogger(), view, 'public', [
					storePathSchema.parse(path.storePath)
				]);

				if (batch.kind !== 'ready') {
					throw new Error('the metadata view must be ready');
				}

				expect(() => [...batch.entries]).toThrow(error);
			});
		}
	);

	it('returns the typed narinfo size refusal for a valid reference row above two MiB', async () => {
		const path = await committedPath(
			'metadata-large-reference-row',
			namedCache('large-reference'),
			{
				storePathHash: 'f'.repeat(32)
			}
		);
		await setView([{ kind: 'named', name: 'large-reference' }]);
		const response = await readFetch(lookupPath(path.storePathHash));
		const original = NarInfo.parse(await response.text());
		const references = referencesSchema.parse(
			Array.from(
				{ length: 8900 },
				(_, index) =>
					`${String(index + 1).padStart(32, '0')}-${'x'.repeat(211)}`
			)
		);
		const referencesJson = JSON.stringify(references);
		const narInfo = NarInfo.fromFields({ ...original.toFields(), references });
		const text = narInfo.render();

		expect(NarInfo.parse(text).toFields()).toStrictEqual(narInfo.toFields());
		expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(
			cacheMetadataMaxNarInfoBytes
		);

		await runInDurableObject(fixtureWorkerServer(), async (instance) => {
			const pathFilter = eq(
				schema.narInfos.storePathHash,
				storePathHashSchema.parse(path.storePathHash)
			);
			instance.context.db
				.update(schema.narInfos)
				.set({ referencesJson })
				.where(pathFilter)
				.run();
			const measured = instance.context.db
				.select({
					bytes: sql<number>`length(cast(${schema.narInfos.referencesJson} as blob))`
				})
				.from(schema.narInfos)
				.where(pathFilter)
				.get();

			expect(measured).toStrictEqual({ bytes: 2_198_301 });

			const render = async () => {
				const batch = await new ReuseViewLookupService(
					instance.context
				).metadata(rootLogger(), view, 'public', [
					storePathSchema.parse(path.storePath)
				]);

				if (batch.kind !== 'ready') {
					throw new Error(
						'the large reference row must produce a ready metadata snapshot'
					);
				}

				return [...batch.entries];
			};

			await expect(render()).rejects.toThrow(MetadataNarInfoTooLargeError);
		});
	});

	it('refuses oversized candidate metadata before reading shared facts', async () => {
		const path = await committedPath('metadata-budget', namedCache('pr-1'), {
			storePathHash: '5'.repeat(32)
		});

		for (const index of [2, 3, 4, 5]) {
			await insertAgreeingCopy(
				namedCache(`pr-${String(index)}`),
				path.storePathHash
			);
		}

		await setView([{ kind: 'prefix', prefix: 'pr-' }]);
		const sharedReads = await runInDurableObject(
			fixtureWorkerServer(),
			async (instance) => {
				instance.context.db
					.update(schema.narInfos)
					.set({ sigsJson: `${' '.repeat(1_750_000)}[]` })
					.where(
						eq(
							schema.narInfos.storePathHash,
							storePathHashSchema.parse(path.storePathHash)
						)
					)
					.run();
				const d1 = vi.spyOn(instance.context.d1, 'batch');
				const r2 = vi.spyOn(instance.context.env.BLOBS, 'head');

				try {
					await expect(
						new ReuseViewLookupService(instance.context).metadata(
							rootLogger(),
							view,
							'public',
							[storePathSchema.parse(path.storePath)]
						)
					).rejects.toThrow(MetadataCandidateBudgetExceededError);

					return { d1: d1.mock.calls.length, r2: r2.mock.calls.length };
				} finally {
					d1.mockRestore();
					r2.mockRestore();
				}
			}
		);

		expect(sharedReads).toStrictEqual({ d1: 0, r2: 0 });
	});

	it('accepts the exact candidate byte limit and refuses one additional byte', async () => {
		const caches = [1, 2, 3, 4, 5].map((index) =>
			namedCache(`boundary-${String(index)}`)
		);
		const first = caches[0];

		if (first === undefined) {
			throw new Error('the candidate boundary needs one source cache');
		}

		const path = await committedPath('metadata-byte-boundary', first, {
			storePathHash: 'd'.repeat(32)
		});

		for (const cache of caches.slice(1)) {
			await insertAgreeingCopy(cache, path.storePathHash);
		}

		await setView([{ kind: 'prefix', prefix: 'boundary-' }]);
		const response = await readFetch(lookupPath(path.storePathHash));
		const expectedNarInfo = await response.text();
		const result = await runInDurableObject(
			fixtureWorkerServer(),
			async (instance) => {
				const hash = storePathHashSchema.parse(path.storePathHash);
				const pathFilter = eq(schema.narInfos.storePathHash, hash);
				const signatures = new Map(
					instance.context.db
						.select({
							cacheId: schema.narInfos.cacheId,
							sigsJson: schema.narInfos.sigsJson
						})
						.from(schema.narInfos)
						.where(pathFilter)
						.all()
						.map((row) => [row.cacheId, row.sigsJson])
				);
				const columns = getTableColumns(schema.narInfos);
				const keys = Object.keys(columns);
				const fixedRowBytes =
					new TextEncoder().encode(JSON.stringify(keys)).byteLength +
					keys.length * 3;
				const scalarBytes = Object.values(columns).map(
					(column) => sql`coalesce(length(cast(${column} as blob)), 4)`
				);
				const rowBytes = sql`${fixedRowBytes} + ${sql.join(scalarBytes, sql` + `)}`;
				const measure = (): number => {
					const measured = instance.context.db
						.select({
							bytes: sql<number>`sum(${rowBytes}) + count(*) + 1`
						})
						.from(schema.narInfos)
						.where(pathFilter)
						.get();

					if (measured === undefined) {
						throw new Error(
							'the candidate input must have a measured byte size'
						);
					}

					return measured.bytes;
				};
				const remaining = cacheMetadataMaxCandidateBytes - measure();
				const share = Math.floor(remaining / caches.length);
				const updatePadding = (index: number, length: number): void => {
					const cache = caches[index];

					if (cache === undefined) {
						throw new Error('the padding must refer to one boundary cache');
					}

					const resolved = instance.context.cacheRepository.require(cache);
					const sigsJson = signatures.get(resolved.id);

					if (sigsJson === undefined) {
						throw new Error('the boundary cache must have a signature set');
					}

					instance.context.db
						.update(schema.narInfos)
						.set({
							sigsJson: `${sigsJson}${' '.repeat(length)}`
						})
						.where(and(pathFilter, eq(schema.narInfos.cacheId, resolved.id)))
						.run();
				};

				for (let index = 0; index < caches.length; index += 1) {
					updatePadding(
						index,
						share + (index < remaining % caches.length ? 1 : 0)
					);
				}

				const exactBytes = measure();
				const service = new ReuseViewLookupService(instance.context);
				const storePaths = [storePathSchema.parse(path.storePath)];
				const batch = await service.metadata(
					rootLogger(),
					view,
					'public',
					storePaths
				);

				if (batch.kind !== 'ready') {
					throw new Error(
						'the exact candidate byte limit must produce a ready batch'
					);
				}

				const entries = [...batch.entries];
				updatePadding(0, share + (remaining % caches.length > 0 ? 1 : 0) + 1);
				const excessBytes = measure();
				let refusal:
					| {
							readonly code: MetadataCandidateBudgetExceededError['code'];
							readonly status: number;
					  }
					| undefined;

				try {
					await service.metadata(rootLogger(), view, 'public', storePaths);
				} catch (error) {
					if (!(error instanceof MetadataCandidateBudgetExceededError)) {
						throw error;
					}

					refusal = { code: error.code, status: error.status };
				}

				return { exactBytes, entries, excessBytes, refusal };
			}
		);

		expect(result).toStrictEqual({
			exactBytes: cacheMetadataMaxCandidateBytes,
			entries: [
				{ storePath: path.storePath, status: 'found', narinfo: expectedNarInfo }
			],
			excessBytes: cacheMetadataMaxCandidateBytes + 1,
			refusal: {
				code: 'candidate-budget-exceeded',
				status: StatusCodes.REQUEST_TOO_LONG
			}
		});
	});

	it('reports a view mutation as a changed batch', async () => {
		const path = await committedPath('metadata-revision', namedCache('pr-1'), {
			storePathHash: '6'.repeat(32)
		});
		await setView([{ kind: 'named', name: 'pr-1' }]);
		const result = await runInDurableObject(
			fixtureWorkerServer(),
			async (instance) => {
				const head = instance.context.env.BLOBS.head.bind(
					instance.context.env.BLOBS
				);
				const intercepted = vi
					.spyOn(instance.context.env.BLOBS, 'head')
					.mockImplementation(async (...arguments_) => {
						instance.context.db
							.update(schema.reuseViews)
							.set({ revision: sql`${schema.reuseViews.revision} + 1` })
							.where(eq(schema.reuseViews.name, view))
							.run();

						return head(...arguments_);
					});

				try {
					return await new ReuseViewLookupService(instance.context).metadata(
						rootLogger(),
						view,
						'public',
						[storePathSchema.parse(path.storePath)]
					);
				} finally {
					intercepted.mockRestore();
				}
			}
		);

		expect(result).toStrictEqual({ kind: 'changed' });
	});

	it.each([1, cacheMetadataMaxPaths])(
		'uses indexed candidate seeks for a metadata preflight of %i paths',
		async (count) => {
			const path = await committedPath(
				`metadata-query-plan-${String(count)}`,
				namedCache('plan'),
				{
					storePathHash: '8'.repeat(30) + String(count).padStart(2, '0')
				}
			);
			await setView([{ kind: 'named', name: 'plan' }]);
			const storePaths = [
				storePathSchema.parse(path.storePath),
				...Array.from({ length: count - 1 }, (_, index) =>
					storePathSchema.parse(
						`/nix/store/${String(index + 100).padStart(32, '0')}-missing`
					)
				)
			];
			const result = await runInDurableObject(
				fixtureWorkerServer(),
				async (instance) => {
					const storage = instance.context.ctx.storage.sql;
					const statements = vi.spyOn(storage, 'exec');
					let query: [string, ...unknown[]] | undefined;

					try {
						await new ReuseViewLookupService(instance.context).metadata(
							rootLogger(),
							view,
							'public',
							storePaths
						);
						query = statements.mock.calls.find(([text]) =>
							text.includes('coalesce(length(cast(')
						);
					} finally {
						statements.mockRestore();
					}

					if (query === undefined) {
						throw new Error(
							'the metadata snapshot must execute its bounded preflight'
						);
					}

					const [text, ...parameters] = query;
					const plan = storage
						.exec<{ detail: string }>(
							`EXPLAIN QUERY PLAN ${text}`,
							...parameters
						)
						.toArray();

					return {
						parameterLimit: parameters.length <= 100,
						indexedNarInfos: plan.some(
							(row) =>
								row.detail.startsWith('SEARCH narinfo ') &&
								row.detail.includes('INDEX')
						),
						scansNarInfos: plan.some((row) =>
							row.detail.startsWith('SCAN narinfo')
						)
					};
				}
			);

			expect(result).toStrictEqual({
				parameterLimit: true,
				indexedNarInfos: true,
				scansNarInfos: false
			});
		}
	);
});
