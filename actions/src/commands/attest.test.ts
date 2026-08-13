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
	provenancedSubjects,
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
				version: 2,
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
				version: 2,
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

// One version-3 receipt subject: its NAR hash is the digest byte repeated, so a
// rendered checksum is readable against the byte the case names.
function provenancedSubject(
	storePath: StorePathString,
	digestByte: string,
	verification: 'local' | 'verified-rebuild' | 'coordinating-store'
) {
	return {
		storePath,
		narHash: digestByte.repeat(32),
		derivation: `${storePath}.drv`,
		buildStore: 'ssh-ng://builder.example',
		verification
	};
}

describe('provenancedSubjects', () => {
	const builtPath = storePathSchema.parse(
		'/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app'
	);
	const remotePath = storePathSchema.parse(
		'/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib'
	);
	const substitutedPath = storePathSchema.parse(
		'/nix/store/4123456789abcdfghijklmnpqrsvwxyz-runtime'
	);

	it.each([
		{ name: 'a local build', verification: 'local' as const },
		{
			name: 'a reproduced remote build',
			verification: 'verified-rebuild' as const
		},
		{
			name: 'a path the selected store realised',
			verification: 'coordinating-store' as const
		}
	])('renders $name from the receipt alone', ({ verification }) => {
		expect(
			provenancedSubjects({
				version: 3,
				paths: [builtPath, substitutedPath],
				subjects: [provenancedSubject(builtPath, 'aa', verification)]
			})
		).toStrictEqual({
			subjects: [{ storePath: builtPath, sha256: 'aa'.repeat(32) }],
			skipped: [substitutedPath],
			refused: []
		});
	});

	it('refuses a subject built on a machine the run did not verify', () => {
		expect(
			provenancedSubjects({
				version: 3,
				paths: [builtPath, remotePath],
				subjects: [
					provenancedSubject(builtPath, 'aa', 'local'),
					{
						storePath: remotePath,
						narHash: 'bb'.repeat(32),
						derivation: `${remotePath}.drv`,
						buildStore: 'auto',
						machine: 'ssh://builder-1',
						verification: 'unverified'
					}
				]
			})
		).toStrictEqual({
			subjects: [{ storePath: builtPath, sha256: 'aa'.repeat(32) }],
			skipped: [],
			refused: [{ storePath: remotePath, machine: 'ssh://builder-1' }]
		});
	});

	it('refuses an unverified subject whose machine the receipt does not name', () => {
		expect(
			provenancedSubjects({
				version: 3,
				paths: [remotePath],
				subjects: [
					{
						storePath: remotePath,
						narHash: 'bb'.repeat(32),
						derivation: `${remotePath}.drv`,
						buildStore: 'auto',
						verification: 'unverified'
					}
				]
			})
		).toStrictEqual({
			subjects: [],
			skipped: [],
			refused: [{ storePath: remotePath }]
		});
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
