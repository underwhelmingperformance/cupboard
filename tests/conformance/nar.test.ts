import { createHash } from 'node:crypto';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

import type { NixArchiveSettings } from '@cupboard/nix';
import { expect, it } from 'vitest';

import { compressNarToStream } from '../../packages/cli/src/nix/blob.ts';
import { NarArchive, toNixSha256 } from '../../packages/cli/src/nix/nar.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';
import { isolatedEnvironment } from '../support/nix.ts';

import { describeConformance, type Oracle } from './oracle.ts';

describeConformance('NAR export', (oracle) => {
	it('matches Nix export of non-UTF-8 symlink targets', async () => {
		await withTemporaryDirectory(
			'cupboard-nar-conformance-',
			async (directory) => {
				const link = path.join(directory, 'link');
				const target = Buffer.concat([
					Buffer.from([0x66, 0x80, 0xff]),
					Buffer.from('~nix~case~hack~1')
				]);

				await symlink(target, link);

				await expectNixArchive(oracle, link, { useCaseHack: true });
			}
		);
	});

	it.skipIf(process.platform !== 'linux').each([true, false])(
		'matches Nix export of non-UTF-8 filenames with use-case-hack=%s',
		async (useCaseHack) => {
			await withTemporaryDirectory(
				'cupboard-nar-conformance-',
				async (directory) => {
					const tree = path.join(directory, 'tree');
					const nested = Buffer.concat([
						Buffer.from(`${tree}/d`),
						Buffer.from([0x80]),
						Buffer.from('~nix~case~hack~1')
					]);

					await mkdir(nested, { recursive: true });
					await writeFile(
						Buffer.concat([nested, Buffer.from('/'), Buffer.from([0xff])]),
						Buffer.alloc(70_003, 0x80)
					);

					for (const name of [
						Buffer.from([0x80]),
						Buffer.from('\u{FFFD}'),
						Buffer.from([0xff])
					]) {
						await writeFile(
							Buffer.concat([Buffer.from(`${tree}/`), name]),
							name
						);
					}

					await symlink(
						Buffer.from([0xff]),
						Buffer.concat([nested, Buffer.from('/'), Buffer.from([0xfe])])
					);

					await expectNixArchive(oracle, tree, { useCaseHack });
				}
			);
		}
	);

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

					await expectNixArchive(oracle, tree, { useCaseHack });
				}
			);
		}
	);
});

async function expectNixArchive(
	oracle: Oracle,
	source: string,
	settings: NixArchiveSettings
): Promise<void> {
	const native = await oracle.runTool(
		'nix-store',
		[
			'--dump',
			source,
			'--option',
			'use-case-hack',
			String(settings.useCaseHack)
		],
		{
			env: await isolatedEnvironment(path.dirname(source)),
			stdoutEncoding: 'base64'
		}
	);

	expect({ status: native.status, stderr: native.stderr }).toStrictEqual({
		status: 0,
		stderr: ''
	});

	const expected = Buffer.from(native.stdout, 'base64');
	const expectedDigest = {
		narHash: toNixSha256(createHash('sha256').update(expected).digest()),
		narSize: expected.byteLength
	};

	const archive = new NarArchive(source, settings);
	const streamed = await Array.fromAsync(archive.stream());
	const suffix = await Array.fromAsync(archive.open(73));
	const compressed = compressNarToStream(archive, expected.byteLength);
	const body = Buffer.concat(await Array.fromAsync(compressed.body));

	expect({
		bytes: Buffer.concat(await Array.fromAsync(archive)),
		stream: Buffer.concat(streamed),
		suffix: Buffer.concat(suffix),
		digest: await archive.hash(),
		decompressed: zstdDecompressSync(body),
		compressedDigest: compressed.digest()
	}).toStrictEqual({
		bytes: expected,
		stream: expected,
		suffix: expected.subarray(73),
		digest: expectedDigest,
		decompressed: expected,
		compressedDigest: expectedDigest
	});
}
