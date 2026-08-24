import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	bootstrap,
	currentNarObjectKey,
	narBytes,
	provisionFixtureTenant,
	pushPath,
	readFetch,
	resetTestServer,
	uploadMetadata
} from '../test-support.ts';

const readUser = 'alice';
const readPassword = 'secret';

function makePrivate(): Promise<void> {
	return provisionFixtureTenant({
		readMode: 'private',
		read: { user: readUser, password: readPassword }
	});
}

function authorised(): RequestInit {
	return {
		headers: { authorization: `Basic ${btoa(`${readUser}:${readPassword}`)}` }
	};
}

describe('private-read mode', () => {
	beforeEach(resetTestServer);

	it('serves reads publicly when no credential is configured', async () => {
		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPath(init.token, metadata);

		const narinfo = await readFetch(`/${metadata.storePathHash}.narinfo`);
		const cacheInfo = await readFetch('/nix-cache-info');

		expect({
			narinfo: narinfo.status,
			cacheInfo: cacheInfo.status
		}).toStrictEqual({ narinfo: StatusCodes.OK, cacheInfo: StatusCodes.OK });
	});

	it('requires Basic auth on narinfo, NAR and nix-cache-info', async () => {
		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPath(init.token, metadata);
		await makePrivate();
		const narinfoPath = `/${metadata.storePathHash}.narinfo`;
		const narPath = `/${await currentNarObjectKey(metadata.narHash)}`;

		const unauthorised = await readFetch(narinfoPath, {});
		const narinfo = await readFetch(narinfoPath, authorised());
		const narUnauthorised = await readFetch(narPath, {});
		const nar = await readFetch(narPath, authorised());
		const cacheInfoUnauthorised = await readFetch('/nix-cache-info', {});
		const cacheInfo = await readFetch('/nix-cache-info', authorised());

		expect({
			unauthorisedStatus: unauthorised.status,
			wwwAuthenticate: unauthorised.headers.get('www-authenticate'),
			narinfoStatus: narinfo.status,
			narinfoControl: narinfo.headers.get('cache-control'),
			narUnauthorisedStatus: narUnauthorised.status,
			narStatus: nar.status,
			narControl: nar.headers.get('cache-control'),
			cacheInfoUnauthorisedStatus: cacheInfoUnauthorised.status,
			cacheInfoStatus: cacheInfo.status,
			cacheInfoControl: cacheInfo.headers.get('cache-control')
		}).toStrictEqual({
			unauthorisedStatus: StatusCodes.UNAUTHORIZED,
			wwwAuthenticate: 'Basic realm="cupboard"',
			narinfoStatus: StatusCodes.OK,
			narinfoControl: 'no-store',
			narUnauthorisedStatus: StatusCodes.UNAUTHORIZED,
			narStatus: StatusCodes.OK,
			narControl: 'no-store',
			cacheInfoUnauthorisedStatus: StatusCodes.UNAUTHORIZED,
			cacheInfoStatus: StatusCodes.OK,
			cacheInfoControl: 'no-store'
		});
	});

	it('forces no-store on an authorised named-cache nix-cache-info', async () => {
		const init = await bootstrap();
		const metadata = uploadMetadata({ fileSize: narBytes.byteLength });
		await pushPath(init.token, metadata, 'builds');
		await makePrivate();

		const cacheInfo = await readFetch(
			'/cache/builds/nix-cache-info',
			authorised()
		);

		expect({
			status: cacheInfo.status,
			control: cacheInfo.headers.get('cache-control')
		}).toStrictEqual({ status: StatusCodes.OK, control: 'no-store' });
	});

	it('leaves the public routes ungated in private mode', async () => {
		await bootstrap();
		await makePrivate();

		const pubkey = await readFetch('/pubkey', {});
		const health = await readFetch('/_health', {});
		const version = await readFetch('/_version', {});

		expect({
			pubkey: pubkey.status,
			health: health.status,
			version: version.status
		}).toStrictEqual({
			pubkey: StatusCodes.OK,
			health: StatusCodes.OK,
			version: StatusCodes.OK
		});
	});

	it('makes only public narinfos eligible for Workers Cache', async () => {
		const init = await bootstrap();
		const privatePath = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'a'.repeat(32),
			name: 'private'
		});
		const publicPath = uploadMetadata({
			fileSize: narBytes.byteLength,
			storePathHash: 'b'.repeat(32),
			name: 'public'
		});
		await pushPath(init.token, privatePath);
		await pushPath(init.token, publicPath);

		await makePrivate();
		const privateResponse = await readFetch(
			`/${privatePath.storePathHash}.narinfo`,
			authorised()
		);

		await provisionFixtureTenant();
		const publicResponse = await readFetch(
			`/${publicPath.storePathHash}.narinfo`
		);

		expect({
			privateControl: privateResponse.headers.get('cache-control'),
			publicControl: publicResponse.headers.get('cache-control')
		}).toStrictEqual({
			privateControl: 'no-store',
			publicControl: 'public, max-age=3600, must-revalidate'
		});
	});
});
