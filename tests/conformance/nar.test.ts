import { createHash } from 'node:crypto';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

import { expect, it } from 'vitest';

import { compressNarToStream } from '../../packages/cli/src/nix/blob.ts';
import { NarArchive, toNixSha256 } from '../../packages/cli/src/nix/nar.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';
import { isolatedEnvironment } from '../support/nix.ts';

import { describeConformance } from './oracle.ts';

describeConformance('NAR filename restoration', (oracle) => {
	it.each([true, false])(
		'matches Nix export with use-case-hack=%s',
		async (useCaseHack) => {
			await withTemporaryDirectory(
				'cupboard-nar-conformance-',
				async (directory) => {
					const tree = path.join(directory, 'tree');
					const nested = path.join(tree, 'a~nix~case~hack~1');

					await mkdir(nested, { recursive: true });
					await writeFile(
						path.join(nested, 'file~nix~case~hack~1'),
						Buffer.from([0, 128, 255, 65])
					);
					await symlink(
						'a~nix~case~hack~1/file~nix~case~hack~1',
						path.join(tree, 'a-')
					);

					const native = await oracle.runTool(
						'nix-store',
						['--dump', tree, '--option', 'use-case-hack', String(useCaseHack)],
						{
							env: await isolatedEnvironment(directory),
							stdoutEncoding: 'base64'
						}
					);

					expect({
						status: native.status,
						stderr: native.stderr
					}).toStrictEqual({ status: 0, stderr: '' });

					const expected = Buffer.from(native.stdout, 'base64');
					const expectedDigest = {
						narHash: toNixSha256(
							createHash('sha256').update(expected).digest()
						),
						narSize: expected.byteLength
					};

					const archive = new NarArchive(tree, { useCaseHack });
					const compressed = compressNarToStream(archive, expected.byteLength);
					const body = Buffer.concat(await Array.fromAsync(compressed.body));

					expect({
						bytes: Buffer.concat(await Array.fromAsync(archive)),
						digest: await archive.hash(),
						decompressed: zstdDecompressSync(body),
						compressedDigest: compressed.digest()
					}).toStrictEqual({
						bytes: expected,
						digest: expectedDigest,
						decompressed: expected,
						compressedDigest: expectedDigest
					});
				}
			);
		}
	);
});
