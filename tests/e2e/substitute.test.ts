import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CupboardClient } from '../../packages/cli/src/client.ts';
import { readFileByteStream } from '../../packages/cli/src/file-stream.ts';
import { NarInfo } from '../../packages/shared/src/narinfo.ts';
import { StorePath } from '../../packages/shared/src/store-path.ts';
import {
	bootstrapToken,
	CupboardTestServer
} from '../support/cupboard-server.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';
import {
	generatePublicKey,
	type NixPathInfo,
	NixStore,
	type RealiseOptions
} from '../support/nix.ts';
import {
	negotiateUpload,
	type PushContext,
	pushStorePaths
} from '../support/push.ts';

const root = path.resolve(import.meta.dirname, '../..');
const contentAddressedFixture = path.join(root, 'tests/fixtures/simple/source');

// An input-addressed derivation whose single-file output embeds the path of a
// `builtins.toFile` dependency, so Nix records that dependency as a reference.
// Keeping the output to a single file lets the builder use only shell
// redirection, which matters because the build sandbox has no PATH.
const referencedDerivation = [
	'let dependency = builtins.toFile "cupboard-dependency" "cupboard dependency";',
	'in derivation {',
	'  name = "cupboard-referrer";',
	'  system = builtins.currentSystem;',
	'  builder = "/bin/sh";',
	'  args = [ "-c" "printf %s \\"${dependency}\\" > \\"$out\\"" ];',
	'}'
].join('\n');

describe('Nix substitution', () => {
	it('substitutes a content-addressed path into a clean store', () =>
		withHarness('cupboard-e2e-ca-', async (harness) => {
			const storePath = await harness.source.add(contentAddressedFixture);

			await pushStorePaths(pushContext(harness), [storePath]);
			await harness.target.realise(
				storePath,
				signedBy(harness, harness.publicKey)
			);

			const realised = harness.target.physicalPath(storePath);

			expect({
				message: await readFile(path.join(realised, 'message.txt'), 'utf8'),
				nested: await readFile(path.join(realised, 'nested/data.txt'), 'utf8')
			}).toStrictEqual({
				message: 'cupboard fixture\n',
				nested: 'stored through nix-store dump\n'
			});
		}));

	it('substitutes an input-addressed path and its references under require-sigs', () =>
		withHarness('cupboard-e2e-signed-', async (harness) => {
			const referrer = await harness.source.build(referencedDerivation);
			const dependency = singleReference(
				await harness.source.pathInfo(referrer)
			);

			await pushStorePaths(pushContext(harness), [dependency, referrer]);

			const narInfo = await fetchNarInfo(harness.server, referrer);

			expect({
				references: narInfo.references,
				signatures: narInfo.sigs
			}).toStrictEqual({
				references: [StorePath.basename(dependency)],
				signatures: [expect.any(String)]
			});

			await harness.target.realise(
				referrer,
				signedBy(harness, harness.publicKey)
			);

			await expect(
				readFile(harness.target.physicalPath(referrer), 'utf8')
			).resolves.toBe(dependency);
		}));

	it('refuses an input-addressed path signed by an untrusted key', () =>
		withHarness('cupboard-e2e-untrusted-', async (harness) => {
			const referrer = await harness.source.build(referencedDerivation);
			const { references } = await harness.source.pathInfo(referrer);

			await pushStorePaths(pushContext(harness), [...references, referrer]);

			const untrustedKey = await generatePublicKey('cupboard-untrusted-1');

			await expect(
				harness.target.realise(referrer, signedBy(harness, untrustedKey))
			).rejects.toThrow();
		}));

	it('rejects a presigned upload whose signature has been tampered with', () =>
		withHarness('cupboard-e2e-tamper-', async (harness) => {
			const storePath = await harness.source.add(contentAddressedFixture);
			const upload = await negotiateUpload(pushContext(harness), storePath);
			const tampered = new URL(upload.uploadUrl);
			tampered.searchParams.set('X-Amz-Signature', '0'.repeat(64));

			await expect(
				harness.client.uploadBlob({
					r2Key: upload.r2Key,
					uploadUrl: tampered.toString(),
					headers: upload.uploadHeaders,
					body: readFileByteStream(upload.compressedPath),
					contentLength: upload.fileSize
				})
			).rejects.toThrow();
		}));
});

interface Harness {
	readonly server: CupboardTestServer;
	readonly source: NixStore;
	readonly target: NixStore;
	readonly client: CupboardClient;
	readonly token: string;
	readonly publicKey: string;
	readonly directory: string;
}

function withHarness(
	prefix: string,
	body: (harness: Harness) => Promise<void>
): Promise<void> {
	return withTemporaryDirectory(
		prefix,
		async (directory) => {
			const server = await CupboardTestServer.start(directory);

			try {
				const client = new CupboardClient(server.url, server.uploadFetcher());
				const bootstrap = await client.bootstrap(bootstrapToken);

				await body({
					server,
					source: await NixStore.host(path.join(directory, 'source-home')),
					target: await NixStore.chroot(
						path.join(directory, 'target-store'),
						path.join(directory, 'target-home')
					),
					client,
					token: bootstrap.token,
					publicKey: bootstrap.publicKey,
					directory
				});
			} finally {
				await server.stop();
			}
		},
		{ makeWritableBeforeCleanup: true }
	);
}

function pushContext(harness: Harness): PushContext {
	return {
		client: harness.client,
		token: harness.token,
		store: harness.source,
		workDirectory: harness.directory
	};
}

function signedBy(harness: Harness, trustedPublicKey: string): RealiseOptions {
	return {
		substituter: harness.server.url.origin,
		trustedPublicKeys: [trustedPublicKey],
		requireSigs: true
	};
}

async function fetchNarInfo(
	server: CupboardTestServer,
	storePath: string
): Promise<NarInfo> {
	const response = await fetch(
		new URL(`/${StorePath.hash(storePath)}.narinfo`, server.url)
	);

	return NarInfo.parse(await response.text());
}

function singleReference(info: NixPathInfo): string {
	const [reference, ...rest] = info.references;

	if (reference === undefined || rest.length > 0) {
		throw new UnexpectedReferenceCountError(info.storePath, info.references);
	}

	return reference;
}

class UnexpectedReferenceCountError extends Error {
	constructor(
		public readonly storePath: string,
		public readonly references: readonly string[]
	) {
		super(
			`Expected exactly one reference for ${storePath}, got ${String(references.length)}`
		);
		this.name = 'UnexpectedReferenceCountError';
	}
}
