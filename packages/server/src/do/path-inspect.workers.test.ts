import {
	storePathHashSchema,
	storePathSchema,
	WIRE_DEFAULT_CACHE
} from '@cupboard/nix-store/scalars';
import { authorizationDetailsSchema } from '@cupboard/protocol/grants';
import { pathInspectionSchema } from '@cupboard/protocol/paths';
import { runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../db/schema.ts';
import {
	authorisedFetch,
	bootstrap,
	currentServer,
	issueServerSignedToken,
	narHash,
	resetTestServer,
	useTestServer
} from '../test-support.ts';

const readOnlyGrants = authorizationDetailsSchema.parse([
	{
		type: 'cupboard_cache',
		actions: ['narinfo:read'],
		cache: WIRE_DEFAULT_CACHE
	}
]);

const storePathHash = storePathHashSchema.parse('0'.repeat(32));
const storePath = storePathSchema.parse(`/nix/store/${storePathHash}-name`);

async function seedNarInfo(origin: string | undefined): Promise<void> {
	await runInDurableObject(currentServer(), (_instance, state) => {
		drizzle(state.storage, { schema })
			.insert(schema.narInfos)
			.values({
				cache: '',
				storePathHash,
				storePath,
				narHash,
				narSize: 1234,
				referencesJson: JSON.stringify([]),
				generation: 0,
				origin,
				createdAt: '2026-01-01T00:00:00.000Z'
			})
			.run();
	});
}

describe('path inspection', () => {
	beforeEach(resetTestServer);

	it('returns the narinfo summary with the S3 push origin', async () => {
		await useTestServer('path-inspect');
		const { token } = await bootstrap();
		await seedNarInfo(
			JSON.stringify({ credentialId: 'cred-1', label: 'nixbuild' })
		);

		const response = await authorisedFetch(
			`/cache/${WIRE_DEFAULT_CACHE}/paths/${storePathHash}`,
			token
		);
		expect(response.status).toBe(StatusCodes.OK);

		const inspection = pathInspectionSchema.parse(await response.json());
		expect(inspection).toStrictEqual({
			cache: '',
			storePathHash,
			storePath,
			narHash,
			narSize: 1234,
			references: [],
			generation: 0,
			createdAt: '2026-01-01T00:00:00.000Z',
			origin: { credentialId: 'cred-1', label: 'nixbuild' }
		});
	});

	it('hides the origin from a read-only token without credential access', async () => {
		await useTestServer('path-inspect-read-only');
		await bootstrap();
		await seedNarInfo(
			JSON.stringify({ credentialId: 'cred-1', label: 'nixbuild' })
		);

		const token = await issueServerSignedToken(readOnlyGrants);
		const response = await authorisedFetch(
			`/cache/${WIRE_DEFAULT_CACHE}/paths/${storePathHash}`,
			token
		);
		expect(response.status).toBe(StatusCodes.OK);

		const inspection = pathInspectionSchema.parse(await response.json());
		expect(inspection.origin).toBeUndefined();
	});

	it('omits the origin for a native push', async () => {
		await useTestServer('path-inspect-native');
		const { token } = await bootstrap();
		await seedNarInfo(undefined);

		const response = await authorisedFetch(
			`/cache/${WIRE_DEFAULT_CACHE}/paths/${storePathHash}`,
			token
		);
		const inspection = pathInspectionSchema.parse(await response.json());
		expect(inspection.origin).toBeUndefined();
	});

	it('reports a missing path as not found', async () => {
		await useTestServer('path-inspect-missing');
		const { token } = await bootstrap();

		const response = await authorisedFetch(
			`/cache/${WIRE_DEFAULT_CACHE}/paths/${storePathHash}`,
			token
		);
		expect(response.status).toBe(StatusCodes.NOT_FOUND);
	});
});
