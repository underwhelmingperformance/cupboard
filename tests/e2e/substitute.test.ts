import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { NarInfo } from '@cupboard/nix-store/narinfo';
import { storePathSchema } from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CupboardClient } from '../../packages/cli/src/client/client.ts';
import { UploadVerificationFailedError } from '../../packages/cli/src/errors.ts';
import type { PushClient } from '../../packages/cli/src/push/push.ts';
import { CupboardTestServer } from '../support/cupboard-server.ts';
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

async function isFilePresent(file: string): Promise<boolean> {
	try {
		await readFile(file);
		return true;
	} catch {
		return false;
	}
}

async function rejectedBy(run: () => Promise<unknown>): Promise<unknown> {
	let rejected: unknown;

	try {
		await run();
	} catch (error) {
		rejected = error;
	}

	return rejected;
}

function expectUploadVerificationFailed(
	error: unknown
): asserts error is UploadVerificationFailedError {
	expect(error).toBeInstanceOf(UploadVerificationFailedError);
}

function namedBytesShape(value: string): {
	readonly name: string;
	readonly rawBytes: number;
} {
	const [name, encoded] = z
		.tuple([z.string().min(1), z.string()])
		.parse(value.split(':'));

	return {
		name,
		rawBytes: Uint8Array.from(
			atob(encoded),
			(character) => character.codePointAt(0) ?? 0
		).byteLength
	};
}

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
				signatures: narInfo.sigs.map((signature) => namedBytesShape(signature))
			}).toStrictEqual({
				references: [StorePath.basename(dependency)],
				signatures: [
					{
						name: namedBytesShape(harness.publicKey).name,
						rawBytes: 64
					}
				]
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

			let outcome: { realised: boolean; targetPresent: boolean };
			try {
				await harness.target.realise(referrer, signedBy(harness, untrustedKey));
				outcome = { realised: true, targetPresent: true };
			} catch {
				outcome = {
					realised: false,
					targetPresent: await isFilePresent(
						harness.target.physicalPath(referrer)
					)
				};
			}

			expect(outcome).toStrictEqual({
				realised: false,
				targetPresent: false
			});
		}));

	it('rejects a commit whose staged bytes do not match the negotiated NAR', () =>
		withHarness('cupboard-e2e-tamper-', async (harness) => {
			const storePath = await harness.source.add(contentAddressedFixture);
			const upload = await negotiateUpload(pushContext(harness), storePath);

			// Corrupt the compressed bytes so they no longer decode to the NAR the
			// commit names. The server derives the hash from what was staged, so a
			// commit over tampered bytes must fail verification.
			const tampered = Uint8Array.from(
				upload.compressed,
				(byte) => byte ^ 0xff
			);
			await harness.server.stageObject(upload.r2Key, tampered);

			const error = await rejectedBy(async () => {
				const outcome = await harness.client.commit(
					{
						uploadId: upload.uploadId,
						storePathHash: upload.storePathHash,
						narHash: upload.narHash
					},
					{}
				);

				// The commit acks first; the tampered bytes fail the background
				// verification, so the mismatch surfaces on the verdict.
				await outcome.settled;
			});

			expectUploadVerificationFailed(error);
			expect({
				uploadId: error.uploadId,
				status: error.status
			}).toStrictEqual({
				uploadId: upload.uploadId,
				status: 'mismatch'
			});
		}));
});

interface Harness {
	readonly server: CupboardTestServer;
	readonly source: NixStore;
	readonly target: NixStore;
	readonly client: PushClient;
	readonly publicKey: string;
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
				const raw = new CupboardClient(server.tenantUrl, fetch, {
					kind: 'default'
				});
				const token = await server.ownerAdminToken();
				const publicKey = await raw.publicKey();

				await body({
					server,
					source: await NixStore.host(path.join(directory, 'source-home')),
					target: await NixStore.chroot(
						path.join(directory, 'target-store'),
						path.join(directory, 'target-home')
					),
					client: server.pushClient(token),
					publicKey
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
		store: harness.source
	};
}

function signedBy(harness: Harness, trustedPublicKey: string): RealiseOptions {
	return {
		substituter: harness.server.tenantUrl.href,
		trustedPublicKeys: [trustedPublicKey],
		requireSigs: true
	};
}

async function fetchNarInfo(
	server: CupboardTestServer,
	storePath: string
): Promise<NarInfo> {
	const response = await fetch(
		server.tenantPath(`/${StorePath.hash(storePath)}.narinfo`)
	);

	return NarInfo.parse(await response.text());
}

function singleReference(info: NixPathInfo): string {
	const [reference] = z.tuple([storePathSchema]).parse(info.references);

	return reference;
}
