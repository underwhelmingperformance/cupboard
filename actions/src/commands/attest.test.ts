import type { NixValidPathInfo } from '@cupboard/nix';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
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

function attestPathInfo(
	storePath: string,
	digestByte: number,
	isUltimate: boolean
): NixValidPathInfo {
	return {
		storePath,
		narHash: NixSha256Hash.fromDigest(Buffer.alloc(32, digestByte)),
		narSize: 1,
		references: [],
		signatures: isUltimate ? [] : ['cache-1:signature'],
		ultimate: isUltimate
	};
}

describe('attestationSubjects', () => {
	const builtPath = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';
	const substitutedPath = '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-lib';

	it('emits subjects for built paths and skips substituted ones', () => {
		const partitioned = attestationSubjects([
			attestPathInfo(builtPath, 0xaa, true),
			attestPathInfo(substitutedPath, 0xbb, false)
		]);

		expect(partitioned).toStrictEqual({
			subjects: [{ storePath: builtPath, sha256: 'aa'.repeat(32) }],
			skipped: [substitutedPath]
		});
	});

	it('emits no subjects when every path was substituted', () => {
		const partitioned = attestationSubjects([
			attestPathInfo(builtPath, 0xaa, false),
			attestPathInfo(substitutedPath, 0xbb, false)
		]);

		expect(partitioned).toStrictEqual({
			subjects: [],
			skipped: [builtPath, substitutedPath]
		});
	});
});

describe('resolveAttestInputs', () => {
	const paths = '/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-foo';

	it('defaults the checksums file under RUNNER_TEMP when none is given', () => {
		const inputs = resolveAttestInputs(
			{ paths: [paths] },
			{ RUNNER_TEMP: '/runner/temp' }
		);

		expect(inputs).toStrictEqual({
			paths: [paths],
			checksumsFile: '/runner/temp/cupboard-attestations/subjects.txt'
		});
	});

	it('honours an explicit checksums file', () => {
		const inputs = resolveAttestInputs(
			{ paths: [paths], checksumsFile: '/somewhere/subjects.txt' },
			{ RUNNER_TEMP: '/runner/temp' }
		);

		expect(inputs).toStrictEqual({
			paths: [paths],
			checksumsFile: '/somewhere/subjects.txt'
		});
	});

	it('requires at least one path', () => {
		expect(() =>
			resolveAttestInputs({ paths: [] }, { RUNNER_TEMP: '/runner/temp' })
		).toThrow(InvalidInputError);
	});

	it('does not require RUNNER_TEMP when the checksums file is explicit', () => {
		const inputs = resolveAttestInputs(
			{ paths: [paths], checksumsFile: '/explicit/subjects.txt' },
			{}
		);

		expect(inputs.checksumsFile).toBe('/explicit/subjects.txt');
	});
});
