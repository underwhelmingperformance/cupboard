import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { createGithubReporter } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import {
	AttestationSubjectNotAcceptedError,
	SubjectNarHashMovedError
} from '../errors.ts';

import { attestCheckAction } from './attest-check.ts';

const tenantUrl = 'https://cache.example.test/t/acme';
const appPath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';
const appDigest = 'aa'.repeat(32);
const runtimePath = '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-runtime';
const runtimeDigest = 'bb'.repeat(32);

function appNarInfo(sha256: string): string {
	const narHash = NixSha256Hash.fromDigest(
		Buffer.from(sha256, 'hex')
	).toString();

	return [
		`StorePath: ${appPath}`,
		`URL: nar/${path.basename(appPath)}.nar.zst`,
		'Compression: zstd',
		`FileHash: ${narHash}`,
		'FileSize: 1',
		`NarHash: ${narHash}`,
		'NarSize: 1',
		'References: ',
		''
	].join('\n');
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
	if (input instanceof URL) {
		return input.href;
	}

	return typeof input === 'string' ? input : input.url;
}

interface Workspace {
	readonly directory: string;
	readonly receiptFile: string;
	readonly checksumsFile: string;
	readonly verifiedChecksumsFile: string;
	readonly outputFile: string;
}

async function workspace(checksums: string): Promise<Workspace> {
	const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-check-'));
	const files = {
		directory,
		receiptFile: path.join(directory, 'receipt.json'),
		checksumsFile: path.join(directory, 'built-subjects.txt'),
		verifiedChecksumsFile: path.join(directory, 'verified-subjects.txt'),
		outputFile: path.join(directory, 'output')
	};
	await writeFile(
		files.receiptFile,
		JSON.stringify({
			version: 3,
			paths: [appPath, runtimePath],
			subjects: [
				{
					origin: 'built',
					storePath: appPath,
					narHash: appDigest,
					derivation: `${appPath}.drv`,
					buildStore: 'auto',
					verification: 'local'
				},
				{
					origin: 'copied',
					storePath: runtimePath,
					narHash: runtimeDigest,
					signatures: []
				}
			]
		})
	);
	await writeFile(files.checksumsFile, checksums);

	return files;
}

function check(files: Workspace, fetcher: typeof fetch): Promise<void> {
	return attestCheckAction(
		{
			receiptFile: files.receiptFile,
			checksumsFile: files.checksumsFile,
			url: tenantUrl
		},
		{ GITHUB_OUTPUT: files.outputFile },
		createGithubReporter(),
		{ fetch: fetcher }
	);
}

describe('attestCheckAction', () => {
	it.each([
		{
			name: 'a listed subject after reading its narinfo',
			checksums: `${appDigest}  ${path.basename(appPath)}\n`,
			requests: [`${tenantUrl}/0123456789abcdfghijklmnpqrsvwxyz.narinfo`],
			verified: `${appDigest}  ${path.basename(appPath)}\n`
		},
		{
			name: 'an empty checksums file without reading any narinfo',
			checksums: '',
			requests: [],
			verified: ''
		}
	])(
		'writes the verified checksums for $name',
		async ({ checksums, requests: expectedRequests, verified }) => {
			const files = await workspace(checksums);
			const requests: string[] = [];

			try {
				await check(files, (input) => {
					requests.push(requestUrl(input));

					return Promise.resolve(new Response(appNarInfo(appDigest)));
				});

				expect({
					requests,
					verified: await readFile(files.verifiedChecksumsFile, 'utf8'),
					outputs: await readFile(files.outputFile, 'utf8')
				}).toStrictEqual({
					requests: expectedRequests,
					verified,
					outputs: `verified-checksums-file=${files.verifiedChecksumsFile}\n`
				});
			} finally {
				await rm(files.directory, { recursive: true, force: true });
			}
		}
	);

	it.each([
		{
			name: 'a subject absent from the receipt',
			checksums: `${appDigest}  4123456789abcdfghijklmnpqrsvwxyz-other\n`,
			unaccepted: ['4123456789abcdfghijklmnpqrsvwxyz-other']
		},
		{
			name: 'a digest that differs from the receipt',
			checksums: `${runtimeDigest}  ${path.basename(appPath)}\n`,
			unaccepted: [path.basename(appPath)]
		}
	])(
		'refuses $name without reading the destination',
		async ({ checksums, unaccepted }) => {
			const files = await workspace(checksums);
			const requests: string[] = [];

			try {
				await expect(
					check(files, (input) => {
						requests.push(requestUrl(input));

						return Promise.resolve(new Response());
					})
				).rejects.toStrictEqual(
					new AttestationSubjectNotAcceptedError(unaccepted)
				);

				expect({
					requests,
					verifiedWritten: existsSync(files.verifiedChecksumsFile)
				}).toStrictEqual({ requests: [], verifiedWritten: false });
			} finally {
				await rm(files.directory, { recursive: true, force: true });
			}
		}
	);

	it('records nothing as verified when the destination serves another NAR hash', async () => {
		const files = await workspace(`${appDigest}  ${path.basename(appPath)}\n`);

		try {
			await expect(
				check(files, () =>
					Promise.resolve(new Response(appNarInfo(runtimeDigest)))
				)
			).rejects.toStrictEqual(
				new SubjectNarHashMovedError(appPath, appDigest, runtimeDigest)
			);

			expect({
				verifiedWritten: existsSync(files.verifiedChecksumsFile),
				outputWritten: existsSync(files.outputFile)
			}).toStrictEqual({ verifiedWritten: false, outputWritten: false });
		} finally {
			await rm(files.directory, { recursive: true, force: true });
		}
	});
});
