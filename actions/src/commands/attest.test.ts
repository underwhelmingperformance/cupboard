import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import { InvalidInputError } from '../errors.ts';
import { parseChecksums } from '../release-install.ts';

import {
	attestationSubjects,
	renderChecksums,
	resolveAttestInputs
} from './attest.ts';

describe('renderChecksums', () => {
	it('renders sha256sum lines that parseChecksums round-trips', () => {
		const rendered = renderChecksums([
			{
				storePath: '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app',
				sha256:
					'1111111111111111111111111111111111111111111111111111111111111111'
			},
			{
				storePath: '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-runtime',
				sha256:
					'2222222222222222222222222222222222222222222222222222222222222222'
			}
		]);

		expect(rendered).toBe(
			'1111111111111111111111111111111111111111111111111111111111111111  0123456789abcdfghijklmnpqrsvwxyz-app\n' +
				'2222222222222222222222222222222222222222222222222222222222222222  3123456789abcdfghijklmnpqrsvwxyz-runtime\n'
		);
		expect(Object.fromEntries(parseChecksums(rendered))).toStrictEqual({
			'0123456789abcdfghijklmnpqrsvwxyz-app':
				'1111111111111111111111111111111111111111111111111111111111111111',
			'3123456789abcdfghijklmnpqrsvwxyz-runtime':
				'2222222222222222222222222222222222222222222222222222222222222222'
		});
	});
});

function attestPathInfo(storePath: StorePathString, digestByte: number) {
	return {
		storePath,
		deriver: `${storePath}.drv`,
		narHash: NixSha256Hash.fromDigest(Buffer.alloc(32, digestByte)),
		narSize: 1,
		references: [],
		signatures: [],
		ultimate: false
	};
}

describe('attestationSubjects', () => {
	const builtPath = storePathSchema.parse(
		'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
	);
	const substitutedPath = storePathSchema.parse(
		'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib'
	);

	it('emits only paths named by the current build receipt', () => {
		const partitioned = attestationSubjects(
			[attestPathInfo(builtPath, 0xaa), attestPathInfo(substitutedPath, 0xbb)],
			{
				version: 1,
				paths: [builtPath, substitutedPath],
				subjects: [
					{
						storePath: builtPath,
						narHash: 'aa'.repeat(32),
						derivation: `${builtPath}.drv`,
						attempt: 1,
						attemptId: 'one'
					}
				]
			}
		);

		expect(partitioned).toStrictEqual({
			subjects: [{ storePath: builtPath, sha256: 'aa'.repeat(32) }],
			skipped: [substitutedPath]
		});
	});

	it('rejects a NAR hash that changed after the receipt was written', () => {
		expect(() =>
			attestationSubjects([attestPathInfo(builtPath, 0xbb)], {
				version: 1,
				paths: [builtPath],
				subjects: [
					{
						storePath: builtPath,
						narHash: 'aa'.repeat(32),
						derivation: `${builtPath}.drv`,
						attempt: 1,
						attemptId: 'one'
					}
				]
			})
		).toThrow(/NAR hash/u);
	});
});

describe('resolveAttestInputs', () => {
	const receiptFile = '/runner/temp/build-receipt.json';

	it('defaults the checksums file under RUNNER_TEMP when none is given', () => {
		const inputs = resolveAttestInputs(
			{ receiptFile },
			{ RUNNER_TEMP: '/runner/temp' }
		);

		expect(inputs).toStrictEqual({
			receiptFile,
			checksumsFile: '/runner/temp/cupboard-attestations/subjects.txt'
		});
	});

	it('honours an explicit checksums file', () => {
		const inputs = resolveAttestInputs(
			{ receiptFile, checksumsFile: '/somewhere/subjects.txt' },
			{ RUNNER_TEMP: '/runner/temp' }
		);

		expect(inputs).toStrictEqual({
			receiptFile,
			checksumsFile: '/somewhere/subjects.txt'
		});
	});

	it('requires a build receipt', () => {
		expect(() =>
			resolveAttestInputs({}, { RUNNER_TEMP: '/runner/temp' })
		).toThrow(InvalidInputError);
	});

	it('does not require RUNNER_TEMP when the checksums file is explicit', () => {
		const inputs = resolveAttestInputs(
			{ receiptFile, checksumsFile: '/explicit/subjects.txt' },
			{}
		);

		expect(inputs.checksumsFile).toBe('/explicit/subjects.txt');
	});
});
