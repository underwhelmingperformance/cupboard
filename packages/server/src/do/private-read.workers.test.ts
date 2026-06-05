import { StatusCodes } from 'http-status-codes';
import { beforeEach, describe, expect, it } from 'vitest';

import {
	bootstrap,
	currentOrigin,
	narBytes,
	pushPath,
	readFetch,
	resetTestServer,
	uploadMetadata
} from '../test-support.ts';

const readUser = 'alice';
const readPassword = 'secret';
const privateEnv = {
	CUPBOARD_READ_USER: readUser,
	CUPBOARD_READ_PASSWORD: readPassword
};

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
		const narinfoPath = `/${metadata.storePathHash}.narinfo`;
		const narPath = `/nar/${metadata.narHash}.nar.zst`;

		const unauthorised = await readFetch(narinfoPath, {}, privateEnv);
		const narinfo = await readFetch(narinfoPath, authorised(), privateEnv);
		const narUnauthorised = await readFetch(narPath, {}, privateEnv);
		const nar = await readFetch(narPath, authorised(), privateEnv);
		const cacheInfoUnauthorised = await readFetch(
			'/nix-cache-info',
			{},
			privateEnv
		);
		const cacheInfo = await readFetch(
			'/nix-cache-info',
			authorised(),
			privateEnv
		);

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

		const cacheInfo = await readFetch(
			'/cache/builds/nix-cache-info',
			authorised(),
			privateEnv
		);

		expect({
			status: cacheInfo.status,
			control: cacheInfo.headers.get('cache-control')
		}).toStrictEqual({ status: StatusCodes.OK, control: 'no-store' });
	});

	it('leaves the public routes ungated in private mode', async () => {
		await bootstrap();

		const pubkey = await readFetch('/pubkey', {}, privateEnv);
		const health = await readFetch('/_health', {}, privateEnv);
		const version = await readFetch('/_version', {}, privateEnv);

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

	it('keeps the edge cache empty in private mode but populates it publicly', async () => {
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

		const privateKey = new URL(
			`/${privatePath.storePathHash}.narinfo`,
			currentOrigin()
		).toString();
		const publicKey = new URL(
			`/${publicPath.storePathHash}.narinfo`,
			currentOrigin()
		).toString();

		await readFetch(
			`/${privatePath.storePathHash}.narinfo`,
			authorised(),
			privateEnv
		);
		await readFetch(`/${publicPath.storePathHash}.narinfo`);

		expect({
			privateCached: (await caches.default.match(privateKey)) !== undefined,
			publicCached: (await caches.default.match(publicKey)) !== undefined
		}).toStrictEqual({ privateCached: false, publicCached: true });
	});
});
