import { spawnSync } from 'node:child_process';
import { createHash, randomInt } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { userInfo } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseTenantCacheUrl } from '@cupboard/nix-store/cache-url';
import { describe, expect, it } from 'vitest';

import { runWithReadAccess } from '../../packages/cli/src/commands/run.ts';
import { discoverNixStoreConfig } from '../../packages/nix/src/store-config.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';
import { ManualClock } from '../support/manual-clock.ts';
import { DivertedNixDaemon, isolatedEnvironment } from '../support/nix.ts';

const isNixAvailable = spawnSync('nix-daemon', ['--version']).status === 0;
const alphabet = '0123456789abcdfghijklmnpqrsvwxyz';
const narFile = fileURLToPath(
	new URL('../fixtures/simple/source.nar', import.meta.url)
);

function storePath(label: string): string {
	const hash = Array.from({ length: 32 }, () =>
		alphabet.charAt(randomInt(alphabet.length))
	).join('');
	return `/nix/store/${hash}-${label}`;
}

describe.skipIf(!isNixAvailable)(
	'renewable read access during one Nix closure substitution',
	() => {
		it(
			'uses the refreshed credential for dependency metadata and NARs after the first token expires',
			() =>
				withTemporaryDirectory(
					'cupboard-read-renewal-',
					async (directory) => {
						const nar = await readFile(narFile);
						const narHash = createHash('sha256').update(nar).digest('hex');
						const target = storePath('target');
						const dependency = storePath('dependency');
						const paths = new Map([
							[path.basename(target).slice(0, 32), target],
							[path.basename(dependency).slice(0, 32), dependency]
						]);
						const requests: {
							readonly path: string;
							readonly credential: string;
							readonly hasExpired: boolean;
						}[] = [];
						let firstExpiresAt = 0;
						const clock = new ManualClock();
						const targetRequested = Promise.withResolvers<undefined>();
						const releaseTarget = Promise.withResolvers<undefined>();
						const server = createServer((request, response) => {
							void (async () => {
								const raw = request.headers.authorization ?? '';
								const credential = raw.startsWith('Basic ')
									? Buffer.from(raw.slice(6), 'base64').toString('utf8')
									: '';
								const requestPath = request.url ?? '';
								const hasExpired =
									firstExpiresAt !== 0 && clock.now() >= firstExpiresAt;
								requests.push({ path: requestPath, credential, hasExpired });
								if (
									credential !== 'second:two' &&
									(credential !== 'first:one' || hasExpired)
								) {
									response.writeHead(401).end();
									return;
								}

								let body: Buffer | string;
								if (requestPath === '/t/acme/nix-cache-info') {
									body =
										'StoreDir: /nix/store\nWantMassQuery: 1\nPriority: 40\n';
								} else if (requestPath.endsWith('.narinfo')) {
									const hash = requestPath.split('/').at(-1)?.slice(0, 32);
									const selected =
										hash === undefined ? undefined : paths.get(hash);
									if (selected === undefined) {
										response.writeHead(404).end();
										return;
									}
									if (selected === target) {
										targetRequested.resolve(undefined);
										await releaseTarget.promise;
									}
									body = `StorePath: ${selected}\nURL: nar/${path.basename(selected)}.nar\nCompression: none\nNarHash: sha256:${narHash}\nNarSize: ${String(nar.length)}\nReferences: ${selected === target ? path.basename(dependency) : ''}\n`;
								} else if (requestPath.startsWith('/t/acme/nar/')) {
									body = nar;
								} else {
									response.writeHead(404).end();
									return;
								}

								response
									.writeHead(200, { 'content-length': Buffer.byteLength(body) })
									.end(body);
							})().catch((error: unknown) =>
								response.destroy(
									error instanceof Error ? error : new Error(String(error))
								)
							);
						});
						server.listen(0, '127.0.0.1');
						let daemon: DivertedNixDaemon | undefined;

						try {
							await once(server, 'listening');
							const address = server.address();
							if (address === null || typeof address === 'string') {
								throw new Error('Expected a TCP server address');
							}
							const tenantUrl = new URL(
								`http://127.0.0.1:${String(address.port)}/t/acme`
							);
							const nixConfig = `substituters = ${tenantUrl.href}\nrequire-sigs = false\n`;
							const daemonConfig = `${nixConfig}trusted-users = ${userInfo().username}\n`;
							let issueCount = 0;
							daemon = await DivertedNixDaemon.start({
								root: path.join(directory, 'store'),
								home: path.join(directory, 'daemon-home'),
								socketPath: path.join(directory, 'daemon.sock'),
								nixConfig: daemonConfig
							});
							const clientEnvironment = await isolatedEnvironment(
								path.join(directory, 'client-home')
							);
							const config = discoverNixStoreConfig();
							const substitution = runWithReadAccess(
								parseTenantCacheUrl(tenantUrl),
								['nix-store', '--realise', target],
								{ githubOidc: true },
								{
									environment: {
										...clientEnvironment,
										NIX_DAEMON_SOCKET_PATH: daemon.socketPath,
										NIX_REMOTE: 'daemon',
										NIX_CONFIG: nixConfig
									},
									storeConfig: {
										...config,
										fileTransfer: {
											...config.fileTransfer,
											netrcFile: path.join(directory, 'missing-original-netrc')
										}
									},
									issue: () => {
										issueCount += 1;
										if (issueCount === 1) {
											firstExpiresAt = clock.now() + 5000;
											return Promise.resolve({
												user: 'first',
												password: 'one',
												expiresAtMs: firstExpiresAt
											});
										}
										return Promise.resolve({
											user: 'second',
											password: 'two',
											expiresAtMs: clock.now() + 900_000
										});
									},
									renewal: {
										now: clock.now,
										wait: clock.wait,
										renewalMarginMs: 3000,
										safetyMarginMs: 1000,
										retryDelayMs: 100
									}
								}
							);

							await Promise.race([
								(async () => {
									await targetRequested.promise;
									await clock.advanceThroughDelay(2000);
									await clock.waitForDelay(897_000);
								})(),
								substitution
							]);
							clock.advanceTo(firstExpiresAt + 200);
							releaseTarget.resolve(undefined);
							await substitution;

							const authenticated = requests
								.filter((request) => request.credential !== '')
								.toSorted((left, right) => left.path.localeCompare(right.path));
							const expected = [
								{
									path: '/t/acme/nix-cache-info',
									credential: 'first:one',
									hasExpired: false
								},
								{
									path: `/t/acme/${path.basename(target).slice(0, 32)}.narinfo`,
									credential: 'first:one',
									hasExpired: false
								},
								{
									path: `/t/acme/${path.basename(dependency).slice(0, 32)}.narinfo`,
									credential: 'second:two',
									hasExpired: true
								},
								{
									path: `/t/acme/nar/${path.basename(target)}.nar`,
									credential: 'second:two',
									hasExpired: true
								},
								{
									path: `/t/acme/nar/${path.basename(dependency)}.nar`,
									credential: 'second:two',
									hasExpired: true
								}
							].toSorted((left, right) => left.path.localeCompare(right.path));
							expect({ issueCount, authenticated }).toStrictEqual({
								issueCount: 2,
								authenticated: expected
							});
						} finally {
							await daemon?.stop();
							await new Promise<void>((resolve, reject) =>
								server.close((error) => {
									if (error === undefined) {
										resolve();
										return;
									}

									reject(error);
								})
							);
						}
					},
					{ makeWritableBeforeCleanup: true }
				),
			120_000
		);
	}
);
