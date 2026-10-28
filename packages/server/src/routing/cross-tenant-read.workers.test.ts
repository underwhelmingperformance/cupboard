import {
	type CacheAccessMode,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	bootstrap,
	cacheWriteGrants,
	clearBlobStorage,
	currentNarObjectKey,
	defaultCache,
	handlerFetch,
	issueTokenForTenant,
	md5Etag,
	provisionFixtureTenant,
	provisionNamedTenant,
	pushPath,
	pushPathToTenant,
	readFetch,
	resetTestServer,
	storedObjectVersion,
	testBase,
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
		vi.setSystemTime(testBase);
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

		const narPath = `/${await currentNarObjectKey(nar.narHash)}`;
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

	it.each<{
		readonly access: CacheAccessMode;
		readonly credentials: Readonly<Record<string, string>>;
	}>([
		{ access: 'public', credentials: {} },
		{
			access: 'private',
			credentials: { authorization: `Basic ${btoa('alice:secret')}` }
		}
	])(
		'serves a shared NAR to a later $access publisher without the upload time of the shared object',
		async ({ access, credentials }) => {
			const nar = await verifiableNar('shared-bytes');
			const metadata = uploadMetadata({
				storePathHash: 'b'.repeat(32),
				references: [],
				narHash: nar.narHash,
				narSize: nar.narSize,
				fileHash: nar.fileHash,
				fileSize: nar.narBytes.byteLength
			});
			const acme = tenantIdSchema.parse('acme');
			const issuer = await provisionNamedTenant(acme);
			const acmeToken = await issueTokenForTenant(
				testServerFor(acme),
				issuer,
				cacheWriteGrants()
			);
			await pushPathToTenant(acme, acmeToken, metadata, nar);
			const key = await currentNarObjectKey(nar.narHash);
			const firstVersion = await storedObjectVersion(key);
			const later = await bootstrap();
			await pushPath(later.token, metadata, defaultCache(), nar);
			await provisionFixtureTenant({
				defaultCacheAccess: access,
				read: { user: 'alice', password: 'secret' }
			});
			const laterKey = await currentNarObjectKey(nar.narHash);
			const read = async (
				method: 'GET' | 'HEAD',
				conditions: Readonly<Record<string, string>> = {}
			) => {
				const response = await readFetch(`/${laterKey}`, {
					method,
					headers: { ...credentials, ...conditions }
				});
				await response.arrayBuffer();

				return {
					status: response.status,
					etag: response.headers.get('etag'),
					lastModified: response.headers.get('last-modified') ?? undefined
				};
			};
			const etag = await md5Etag(nar.narBytes);
			const served = { status: StatusCodes.OK, etag, lastModified: undefined };

			expect({
				firstVersion: typeof firstVersion,
				object: { key: laterKey, version: await storedObjectVersion(key) },
				get: await read('GET'),
				head: await read('HEAD'),
				ifModifiedSince: await read('GET', {
					'if-modified-since': 'Fri, 01 Jan 2100 00:00:00 GMT'
				}),
				ifNoneMatch: await read('GET', { 'if-none-match': etag })
			}).toStrictEqual({
				firstVersion: 'string',
				object: { key, version: firstVersion },
				get: served,
				head: served,
				ifModifiedSince: served,
				ifNoneMatch: { ...served, status: StatusCodes.NOT_MODIFIED }
			});
		}
	);
});
