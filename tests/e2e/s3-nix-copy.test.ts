import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CupboardClient } from '../../packages/cli/src/client/client.ts';
import { tenantRpc } from '../../packages/cli/src/client/orpc.ts';
import { fixtureTenant } from '../../packages/server/src/routing/tenant-routing.test-support.ts';
import { CupboardTestServer } from '../support/cupboard-server.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';
import { NixStore } from '../support/nix.ts';
import { CommandFailedError } from '../support/process.ts';

const s3SecretKey = 'AAcOFRwjKjE4P0ZNVFtiaXB3foWMk5qhqK+2vcTL0tk=';
const derivation = [
	'derivation {',
	'  name = "cupboard-s3-copy";',
	'  system = builtins.currentSystem;',
	'  builder = "/bin/sh";',
	String.raw`  args = [ "-c" "/bin/cp /bin/sh \"$out\"" ];`,
	'}'
].join('\n');

const copyModes = [
	{ name: 'a single request', multipart: false },
	{ name: 'multipart requests', multipart: true }
] as const;

function destinationFor(serverUrl: URL, isMultipart: boolean): string {
	const endpoint = new URL(serverUrl);
	endpoint.hostname = 'localhost';
	const destination = new URL(`s3://${fixtureTenant}`);
	destination.searchParams.set('region', 'auto');
	destination.searchParams.set('endpoint', endpoint.origin);
	destination.searchParams.set('addressing-style', 'path');
	destination.searchParams.set('compression', 'zstd');
	if (isMultipart) {
		destination.searchParams.set('multipart-upload', 'true');
		destination.searchParams.set('multipart-threshold', '4096');
		destination.searchParams.set('multipart-chunk-size', '5242880');
	}

	return destination.href;
}

function s3Environment(credential: {
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
}): Readonly<Record<string, string>> {
	return {
		AWS_ACCESS_KEY_ID: credential.accessKeyId,
		AWS_SECRET_ACCESS_KEY: credential.secretAccessKey,
		AWS_EC2_METADATA_DISABLED: 'true'
	};
}

describe('Nix copy through the S3 endpoint', () => {
	it.each(copyModes)(
		'uploads with $name, then substitutes the path',
		({ multipart: isMultipart }) =>
			withTemporaryDirectory(
				'cupboard-e2e-s3-nix-',
				async (directory) => {
					const server = await CupboardTestServer.start(directory, {
						bindings: {
							CUPBOARD_LOCAL_DEV: 'true',
							S3_HOST: 'localhost',
							S3_SECRET_KEY: s3SecretKey
						}
					});

					try {
						const token = await server.ownerAdminToken();
						const credential = await tenantRpc(server.tenantUrl, {
							credential: token
						}).s3Credentials.create({
							cache: '',
							label: 'nix-copy-e2e',
							writable: true
						});
						const source = await NixStore.host(
							path.join(directory, 'source-home')
						);
						const storePath = await source.build(derivation);
						const sourceContents = await readFile(
							source.physicalPath(storePath)
						);
						await source.copyTo([storePath], {
							destination: destinationFor(server.url, isMultipart),
							environment: s3Environment(credential)
						});

						const publicKey = await new CupboardClient(
							server.tenantUrl
						).publicKey();
						const target = await NixStore.chroot(
							path.join(directory, 'target-store'),
							path.join(directory, 'target-home')
						);
						const substitutedPath = await target.buildOnlyFromSubstituter(
							derivation,
							{
								substituter: server.tenantUrl.href,
								trustedPublicKeys: [publicKey],
								requireSigs: true
							}
						);

						const uploads = server
							.observedRequests()
							.filter((request) => request.method === 'PUT')
							.map((request) => ({
								kind: new URL(request.path, server.url).searchParams.has(
									'partNumber'
								)
									? 'part'
									: 'object',
								hasKnownLength: request.contentLength !== undefined,
								isLargerThanThreshold: (request.contentLength ?? 0) > 4096,
								contentSha256: request.contentSha256
							}));
						const expectedKinds = isMultipart
							? (['part', 'object'] as const)
							: (['object', 'object'] as const);
						expect({
							substitutedPath,
							targetContents: await readFile(
								target.physicalPath(substitutedPath)
							),
							uploads,
							state: await server.s3StagingState()
						}).toStrictEqual({
							substitutedPath: storePath,
							targetContents: sourceContents,
							uploads: [
								{
									kind: expectedKinds[0],
									hasKnownLength: true,
									isLargerThanThreshold: true,
									contentSha256: 'UNSIGNED-PAYLOAD'
								},
								{
									kind: expectedKinds[1],
									hasKnownLength: true,
									isLargerThanThreshold: false,
									contentSha256: 'UNSIGNED-PAYLOAD'
								}
							],
							state: {
								stagedBytes: 0,
								multipartBytes: 0,
								stagedObjects: 0,
								multipartUploads: 0,
								multipartParts: 0,
								stagedR2Keys: []
							}
						});
					} finally {
						await server.stop();
					}
				},
				{ makeWritableBeforeCleanup: true }
			)
	);

	it('returns a quota error and removes a refused multipart upload', () =>
		withTemporaryDirectory(
			'cupboard-e2e-s3-quota-',
			async (directory) => {
				const server = await CupboardTestServer.start(directory, {
					bindings: {
						CUPBOARD_LOCAL_DEV: 'true',
						S3_HOST: 'localhost',
						S3_SECRET_KEY: s3SecretKey
					},
					provision: { readMode: 'public', quotaBytes: 1 }
				});

				try {
					const token = await server.ownerAdminToken();
					const credential = await tenantRpc(server.tenantUrl, {
						credential: token
					}).s3Credentials.create({
						cache: '',
						label: 'nix-copy-quota-e2e',
						writable: true
					});
					const source = await NixStore.host(
						path.join(directory, 'source-home')
					);
					const storePath = await source.build(derivation);
					let failure: unknown;
					try {
						await source.copyTo([storePath], {
							destination: destinationFor(server.url, true),
							environment: s3Environment(credential)
						});
					} catch (error) {
						failure = error;
					}
					if (!(failure instanceof CommandFailedError)) {
						throw new Error('Nix copy did not report a command failure.');
					}

					const partRequest = server.observedRequests().find((request) => {
						const url = new URL(request.path, server.url);
						return (
							request.method === 'PUT' && url.searchParams.has('partNumber')
						);
					});
					if (partRequest === undefined) {
						throw new Error('Nix did not send a multipart upload part.');
					}
					const partUrl = new URL(partRequest.path, server.url);
					const uploadId = partUrl.searchParams.get('uploadId');
					const [, bucket, directoryName, fileName] = partUrl.pathname.split(
						'/',
						5
					);
					const hash = /^([^.]+)\.nar\.zst$/u.exec(fileName ?? '')?.[1];
					if (
						uploadId === null ||
						bucket !== fixtureTenant ||
						directoryName !== 'nar' ||
						hash === undefined
					) {
						throw new Error(
							'Multipart request did not identify its staged upload.'
						);
					}
					const r2Key = `staging/s3/${fixtureTenant}/_default/sha256:${hash}.nar.zst`;

					expect({
						protocolError: failure.result.stderr.includes(
							'<Code>EntityTooLarge</Code>'
						),
						state: await server.s3StagingState(),
						multipartUploadAcceptsPart: await server.multipartUploadAcceptsPart(
							r2Key,
							uploadId
						)
					}).toStrictEqual({
						protocolError: true,
						state: {
							stagedBytes: 0,
							multipartBytes: 0,
							stagedObjects: 0,
							multipartUploads: 0,
							multipartParts: 0,
							stagedR2Keys: []
						},
						multipartUploadAcceptsPart: false
					});
				} finally {
					await server.stop();
				}
			},
			{ makeWritableBeforeCleanup: true }
		));
});
