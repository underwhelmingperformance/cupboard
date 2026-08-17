import {
	narInfoGenerationSchema,
	storePathHashSchema,
	storePathSchema,
	WIRE_DEFAULT_CACHE
} from '@cupboard/nix-store/scalars';
import { authorizationDetailsSchema } from '@cupboard/protocol/grants';
import { pathInspectionSchema } from '@cupboard/protocol/paths';
import { isoTimestampSchema } from '@cupboard/protocol/scalars';
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
				generation: narInfoGenerationSchema.parse(0),
				origin,
				createdAt: isoTimestampSchema.parse('2026-01-01T00:00:00.000Z')
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
			origin: {
				kind: 's3',
				credentialId: 'cred-1',
				label: 'nixbuild'
			}
		});
	});

	it('reports a redacted S3 origin without credential access', async () => {
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
		expect(inspection.origin).toStrictEqual({ kind: 'redacted' });
	});

	it('reports a native push explicitly', async () => {
		await useTestServer('path-inspect-native');
		const { token } = await bootstrap();
		await seedNarInfo(undefined);

		const response = await authorisedFetch(
			`/cache/${WIRE_DEFAULT_CACHE}/paths/${storePathHash}`,
			token
		);
		const inspection = pathInspectionSchema.parse(await response.json());
		expect(inspection.origin).toStrictEqual({ kind: 'native' });
	});

	it('reports an invalid stored origin as a server fault', async () => {
		await useTestServer('path-inspect-invalid-origin');
		const { token } = await bootstrap();
		await seedNarInfo('{not json');

		const response = await authorisedFetch(
			`/cache/${WIRE_DEFAULT_CACHE}/paths/${storePathHash}`,
			token
		);

		expect({
			status: response.status,
			body: await response.json()
		}).toStrictEqual({
			status: StatusCodes.INTERNAL_SERVER_ERROR,
			body: {
				defined: false,
				code: 'INTERNAL_SERVER_ERROR',
				status: StatusCodes.INTERNAL_SERVER_ERROR,
				message: 'Stored upload origin is invalid'
			}
		});
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
