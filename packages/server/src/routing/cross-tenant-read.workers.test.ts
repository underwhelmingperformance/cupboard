import { tenantIdSchema } from '@cupboard/nix/scalars';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	cacheWriteGrants,
	clearBlobStorage,
	deleteTestBase,
	handlerFetch,
	issueTokenForTenant,
	provisionNamedTenant,
	pushPathToTenant,
	resetTestServer,
	testServerFor,
	uploadMetadata,
	verifiableNar
} from '../test-support.ts';

// NAR bytes are content-addressed and shared at rest, but read access is
// per-tenant. A tenant must hold its own `tenant_blob` presence edge for a hash
// before the shared object is served or its existence revealed through that
// tenant's prefix, so one tenant's bytes are never readable through another's
// path and the content-addressed store is not a cross-tenant existence oracle.

describe('cross-tenant NAR read isolation', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(deleteTestBase);
		await resetTestServer();
		await clearBlobStorage();
	});

	it('serves a NAR to its owner but 404s a tenant that does not reference it', async () => {
		const ownerIssuer = await provisionNamedTenant('acme');
		const ownerToken = await issueTokenForTenant(
			testServerFor('acme'),
			ownerIssuer,
			cacheWriteGrants()
		);
		// A second public tenant that never uploads the hash; it must not be able to
		// read acme's bytes by naming the content hash under its own prefix.
		await provisionNamedTenant('mallory');

		const nar = await verifiableNar('acme-private-bytes');
		const metadata = uploadMetadata({
			storePathHash: 'a'.repeat(32),
			references: [],
			narHash: nar.narHash,
			narSize: nar.narSize,
			fileHash: nar.fileHash,
			fileSize: nar.narBytes.byteLength
		});
		await pushPathToTenant(
			tenantIdSchema.parse('acme'),
			ownerToken,
			metadata,
			nar
		);

		const narPath = `/nar/${nar.narHash}.nar.zst`;
		const ownerGet = await handlerFetch(`/t/acme${narPath}`);
		const intruderGet = await handlerFetch(`/t/mallory${narPath}`);
		const ownerHead = await handlerFetch(`/t/acme${narPath}`, {
			method: 'HEAD'
		});
		const intruderHead = await handlerFetch(`/t/mallory${narPath}`, {
			method: 'HEAD'
		});

		expect({
			ownerGet: ownerGet.status,
			intruderGet: intruderGet.status,
			ownerHead: ownerHead.status,
			intruderHead: intruderHead.status
		}).toStrictEqual({
			ownerGet: StatusCodes.OK,
			intruderGet: StatusCodes.NOT_FOUND,
			ownerHead: StatusCodes.OK,
			intruderHead: StatusCodes.NOT_FOUND
		});
	});
});
