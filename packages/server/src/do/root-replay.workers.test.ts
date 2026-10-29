import {
	rootEnsureResponseSchema,
	rootSetResponseSchema
} from '@cupboard/protocol/retention';
import { runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../db/schema.ts';
import {
	authorisedFetch,
	currentServer,
	initialise,
	narBytes,
	pushPath,
	resetTestServer,
	resolvedCache,
	testBase,
	uploadMetadata
} from '../test-support.ts';

import { type ServerContext } from './context.ts';
import { inputState } from './garbage-collection.test-support.ts';

const fourteenDaysInSeconds = 14 * 24 * 60 * 60;
// The repeat stays within the ten-minute lifetime of the test's access token.
const fiveMinutesLater = new Date(testBase.getTime() + 5 * 60 * 1000);
const target = uploadMetadata({
	fileSize: narBytes.byteLength,
	storePathHash: 'c'.repeat(32),
	name: 'channel'
});
const renamedStorePath = `/nix/store/${target.storePathHash}-renamed`;

// Each statement records every insert into and delete from the target table, so
// a test can tell rows that a write kept from rows that it replaced with equal
// values.
const targetWriteLog = [
	'CREATE TABLE test_root_target_write (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL)',
	"CREATE TRIGGER test_root_target_insert AFTER INSERT ON retention_root_target BEGIN INSERT INTO test_root_target_write (kind) VALUES ('insert'); END",
	"CREATE TRIGGER test_root_target_delete AFTER DELETE ON retention_root_target BEGIN INSERT INTO test_root_target_write (kind) VALUES ('delete'); END"
];

function rootBody(storePath: string): string {
	return JSON.stringify({
		targets: [storePath],
		retention: { kind: 'duration', seconds: fourteenDaysInSeconds }
	});
}

const rootWrites = [
	{
		name: 'set',
		send: async (token: string, storePath: string): Promise<unknown> => {
			const response = await authorisedFetch('/roots/channel', token, {
				method: 'PUT',
				headers: { 'content-type': 'application/json' },
				body: rootBody(storePath)
			});

			expect(response.status).toBe(StatusCodes.OK);

			return rootSetResponseSchema.parse(await response.json());
		},
		response: (summary: object): object => summary
	},
	{
		name: 'ensure',
		send: async (token: string, storePath: string): Promise<unknown> => {
			const response = await authorisedFetch('/roots/channel/ensure', token, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: rootBody(storePath)
			});

			expect(response.status).toBe(StatusCodes.OK);

			return rootEnsureResponseSchema.parse(await response.json());
		},
		response: (summary: object): object => ({
			status: 'retained',
			root: summary
		})
	}
] as const;

const repeats = [
	{ name: 'an identical request', storePath: target.storePath },
	{
		name: 'a request with the same hash and another store path',
		storePath: renamedStorePath
	}
] as const;

function storedRoot(context: ServerContext, sql: SqlStorage) {
	const cacheId = resolvedCache(context).id;

	return {
		roots: context.db
			.select()
			.from(schema.retentionRoots)
			.where(eq(schema.retentionRoots.cacheId, cacheId))
			.all(),
		targets: context.db
			.select()
			.from(schema.retentionRootTargets)
			.where(eq(schema.retentionRootTargets.cacheId, cacheId))
			.all(),
		inputs: inputState(context),
		targetWrites: Array.from(
			sql.exec<{ kind: string }>(
				'SELECT kind FROM test_root_target_write ORDER BY seq'
			),
			(row) => row.kind
		)
	};
}

function clearInputs(context: ServerContext): void {
	context.db
		.update(schema.garbageCollectionInputs)
		.set({ inputsChanged: false })
		.where(
			eq(schema.garbageCollectionInputs.cacheId, resolvedCache(context).id)
		)
		.run();
}

describe('repeated root writes', () => {
	beforeEach(resetTestServer);

	it.each(
		rootWrites.flatMap((write) =>
			repeats.map((repeat) => ({ ...write, repeat }))
		)
	)(
		'refreshes the root on $repeat.name to $name',
		async ({ send, response, repeat }) => {
			const token = await initialise();

			await pushPath(token, target);
			await send(token, target.storePath);

			const before = await runInDurableObject(
				currentServer(),
				(instance, state) => {
					clearInputs(instance.context);

					for (const statement of targetWriteLog) {
						state.storage.sql.exec(statement);
					}

					return storedRoot(instance.context, state.storage.sql);
				}
			);

			vi.setSystemTime(fiveMinutesLater);

			const repeated = await send(token, repeat.storePath);
			const after = await runInDurableObject(
				currentServer(),
				(instance, state) => storedRoot(instance.context, state.storage.sql)
			);
			const refreshed = {
				expiresAt: '2026-01-15T00:05:00.000Z',
				updatedAt: fiveMinutesLater.toISOString()
			};
			const isIdentical = repeat.storePath === target.storePath;

			expect({ repeated, after }).toStrictEqual({
				repeated: response({
					name: 'channel',
					...refreshed,
					expired: false,
					createdAt: testBase.toISOString(),
					targets: [
						{
							storePathHash: target.storePathHash,
							storePath: repeat.storePath,
							present: true
						}
					]
				}),
				after: {
					roots: before.roots.map((root) => ({ ...root, ...refreshed })),
					targets: before.targets.map((row) => ({
						...row,
						storePath: repeat.storePath
					})),
					inputs: { ...before.inputs, inputsChanged: !isIdentical },
					targetWrites: isIdentical ? [] : ['delete', 'insert']
				}
			});
		}
	);
});
