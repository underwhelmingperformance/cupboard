import { NixSha256Hash } from '@cupboard/nix-store/hash';
import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { describe, expect, it } from 'vitest';

import {
	InvalidInputError,
	SubjectDeriverMovedError,
	SubjectNarHashMovedError,
	SubjectNotHeldError
} from '../errors.ts';
import { parseChecksums } from '../release-install.ts';

import {
	attestationSubjects,
	type LocalPathInfos,
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
	verification: 'local' | 'verified-rebuild' | 'build-store'
) {
	return {
		storePath,
		narHash: digestByte.repeat(32),
		derivation: `${storePath}.drv`,
		buildStore: 'ssh-ng://builder.example',
		verification
	};
}

// A machine holding none of the receipt's subjects, which is what a run
// attesting a remote store's work looks like.
const heldNowhere: LocalPathInfos = new Map();

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

	const realisedHere = [
		{ name: 'a local build', verification: 'local' as const },
		{
			name: 'a reproduced remote build',
			verification: 'verified-rebuild' as const
		}
	];

	// The store of a machine that still holds what it built, under the NAR hash
	// and deriver its receipt recorded.
	const holdsBuiltPath: LocalPathInfos = new Map([
		[builtPath, attestPathInfo(builtPath, 0xaa)]
	]);

	it.each(realisedHere)(
		'attests $name whose path this machine still holds',
		({ verification }) => {
			expect(
				provenancedSubjects(
					{
						version: 3,
						paths: [builtPath, substitutedPath],
						subjects: [provenancedSubject(builtPath, 'aa', verification)]
					},
					holdsBuiltPath
				)
			).toStrictEqual({
				subjects: [{ storePath: builtPath, sha256: 'aa'.repeat(32) }],
				skipped: [substitutedPath],
				refused: []
			});
		}
	);

	it.each(realisedHere)(
		'refuses $name whose path this machine no longer holds',
		({ verification }) => {
			let failure: unknown;

			try {
				provenancedSubjects(
					{
						version: 3,
						paths: [builtPath],
						subjects: [provenancedSubject(builtPath, 'aa', verification)]
					},
					heldNowhere
				);
			} catch (error) {
				failure = error;
			}

			expect(failure).toBeInstanceOf(SubjectNotHeldError);

			if (failure instanceof SubjectNotHeldError) {
				expect({
					storePath: failure.storePath,
					verification: failure.verification
				}).toStrictEqual({ storePath: builtPath, verification });
			}
		}
	);

	// A subject this machine holds is one the run can check for itself, and
	// the checksum it renders is signed under this repository's identity.
	it.each([
		{
			name: 'a NAR hash that moved since the receipt was written',
			digestByte: 0xcc,
			deriver: `${builtPath}.drv`,
			expected: SubjectNarHashMovedError
		},
		{
			name: 'a deriver that moved since the receipt was written',
			digestByte: 0xaa,
			deriver: `${remotePath}.drv`,
			expected: SubjectDeriverMovedError
		}
	])(
		'refuses to attest a held subject with $name',
		({ digestByte, deriver, expected }) => {
			const held: LocalPathInfos = new Map([
				[
					builtPath,
					{
						storePath: builtPath,
						narHash: NixSha256Hash.fromDigest(Buffer.alloc(32, digestByte)),
						narSize: 1,
						references: [],
						deriver,
						signatures: [],
						ultimate: true
					}
				]
			]);

			expect(() =>
				provenancedSubjects(
					{
						version: 3,
						paths: [builtPath],
						subjects: [provenancedSubject(builtPath, 'aa', 'local')]
					},
					held
				)
			).toThrow(expected);
		}
	);

	// A subject the selected build store realised is not on this machine, so
	// the receipt is what the run established about it.
	it('attests a build-store subject this machine does not hold from the receipt', () => {
		expect(
			provenancedSubjects(
				{
					version: 3,
					paths: [remotePath],
					subjects: [provenancedSubject(remotePath, 'bb', 'build-store')]
				},
				heldNowhere
			)
		).toStrictEqual({
			subjects: [{ storePath: remotePath, sha256: 'bb'.repeat(32) }],
			skipped: [],
			refused: []
		});
	});

	it('refuses a subject built on a machine the run did not verify', () => {
		expect(
			provenancedSubjects(
				{
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
				},
				holdsBuiltPath
			)
		).toStrictEqual({
			subjects: [{ storePath: builtPath, sha256: 'aa'.repeat(32) }],
			skipped: [],
			refused: [{ storePath: remotePath, machine: 'ssh://builder-1' }]
		});
	});

	it('refuses an unverified subject whose machine the receipt does not name', () => {
		expect(
			provenancedSubjects(
				{
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
				},
				heldNowhere
			)
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
