import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildOriginPredicateType } from '@cupboard/protocol/build-origin';
import { createGithubReporter } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import type {
	AttestationStatement,
	AttestationSubject
} from '../attestation-signing.ts';
import {
	AttestationPredicateFileError,
	AttestationSigningError,
	InvalidInputError,
	MissingInputError
} from '../errors.ts';

import {
	attestSignAction,
	type AttestSignDependencies,
	type AttestSignOptions,
	resolveAttestSignInputs
} from './attest-sign.ts';

const appName = '0123456789abcdfghijklmnpqrsvwxyz-app';
const appDigest = '11'.repeat(32);
const runtimeName = '3123456789abcdfghijklmnpqrsvwxyz-runtime';
const runtimeDigest = '22'.repeat(32);

const originPredicate = {
	subjects: [
		{
			storePath: `/nix/store/${appName}`,
			narHash: appDigest,
			derivation: `/nix/store/${appName}.drv`,
			buildStore: 'auto',
			verification: 'observed'
		}
	]
};

interface SigningRecord {
	readonly subjects: readonly AttestationSubject[];
	readonly statement: AttestationStatement;
}

interface Workspace {
	readonly directory: string;
	readonly checksumsFile: string;
	readonly predicateFile: string;
	readonly outputFile: string;
}

async function workspace(): Promise<Workspace> {
	const directory = await mkdtemp(path.join(tmpdir(), 'cupboard-sign-'));
	const checksumsFile = path.join(directory, 'subjects.txt');
	const predicateFile = path.join(directory, 'build-origin.json');

	await writeFile(
		checksumsFile,
		`${appDigest}  ${appName}\n${runtimeDigest}  ${runtimeName}\n`
	);
	await writeFile(predicateFile, `${JSON.stringify(originPredicate)}\n`);

	return {
		directory,
		checksumsFile,
		predicateFile,
		outputFile: path.join(directory, 'output')
	};
}

function options(
	files: Workspace,
	overrides: Partial<AttestSignOptions> = {}
): AttestSignOptions {
	return {
		checksumsFile: files.checksumsFile,
		predicateFile: files.predicateFile,
		predicateType: buildOriginPredicateType,
		githubToken: 'token',
		...overrides
	};
}

/** Records what each statement was signed with and returns a fixed bundle. */
function recordingSigner(
	records: SigningRecord[],
	failures: readonly Error[] = []
): AttestSignDependencies {
	return {
		delay: () => Promise.resolve(),
		provenanceStatement: () =>
			Promise.resolve({
				predicateType: 'https://slsa.dev/provenance/v1',
				predicate: { buildDefinition: { buildType: 'workflow' } }
			}),
		signerFor: (subjects) => (statement) => {
			const failure = failures[records.length];
			records.push({ subjects, statement });

			return failure === undefined
				? Promise.resolve({
						bundle: `{"predicateType":"${statement.predicateType}"}\n`
					})
				: Promise.reject(failure);
		}
	};
}

async function outputsOf(outputFile: string): Promise<Record<string, string>> {
	const written = await readFile(outputFile, 'utf8');

	return Object.fromEntries(
		written
			.split('\n')
			.filter((line) => line.length > 0)
			.map((line) => {
				const separator = line.indexOf('=');

				return [line.slice(0, separator), line.slice(separator + 1)];
			})
	);
}

describe('resolveAttestSignInputs', () => {
	it('defaults both bundle paths to the checksums file directory', () => {
		expect(
			resolveAttestSignInputs({
				checksumsFile: '/runner/temp/attestations/subjects.txt',
				predicateFile: '/runner/temp/attestations/build-origin.json',
				predicateType: buildOriginPredicateType,
				githubToken: 'token'
			})
		).toStrictEqual({
			checksumsFile: '/runner/temp/attestations/subjects.txt',
			predicateFile: '/runner/temp/attestations/build-origin.json',
			predicateType: buildOriginPredicateType,
			githubToken: 'token',
			bundleFile: '/runner/temp/attestations/provenance.sigstore.json',
			originBundleFile: '/runner/temp/attestations/build-origin.sigstore.json'
		});
	});

	it.each([
		{
			missing: 'checksums-file',
			options: { githubToken: 'token' },
			expected: MissingInputError
		},
		{
			missing: 'github-token',
			options: { checksumsFile: '/runner/temp/subjects.txt' },
			expected: MissingInputError
		},
		{
			missing: 'predicate-type',
			options: {
				checksumsFile: '/runner/temp/subjects.txt',
				predicateFile: '/runner/temp/build-origin.json',
				githubToken: 'token'
			},
			expected: InvalidInputError
		}
	])('refuses inputs without $missing', ({ options: given, expected }) => {
		expect(() => resolveAttestSignInputs(given)).toThrow(expected);
	});
});

describe('attestSignAction', () => {
	it('signs both statements over the same subjects', async () => {
		const files = await workspace();
		const records: SigningRecord[] = [];

		try {
			await attestSignAction(
				options(files),
				{ GITHUB_OUTPUT: files.outputFile },
				createGithubReporter(),
				recordingSigner(records)
			);

			const bundleFile = path.join(files.directory, 'provenance.sigstore.json');
			const originBundleFile = path.join(
				files.directory,
				'build-origin.sigstore.json'
			);

			expect({
				records,
				outputs: await outputsOf(files.outputFile),
				bundle: await readFile(bundleFile, 'utf8'),
				originBundle: await readFile(originBundleFile, 'utf8')
			}).toStrictEqual({
				records: [
					{
						subjects: [
							{ name: appName, sha256: appDigest },
							{ name: runtimeName, sha256: runtimeDigest }
						],
						statement: {
							predicateType: 'https://slsa.dev/provenance/v1',
							predicate: { buildDefinition: { buildType: 'workflow' } }
						}
					},
					{
						subjects: [
							{ name: appName, sha256: appDigest },
							{ name: runtimeName, sha256: runtimeDigest }
						],
						statement: {
							predicateType: buildOriginPredicateType,
							predicate: originPredicate
						}
					}
				],
				outputs: {
					'bundle-path': bundleFile,
					'origin-bundle-path': originBundleFile
				},
				bundle: '{"predicateType":"https://slsa.dev/provenance/v1"}\n',
				originBundle: `{"predicateType":"${buildOriginPredicateType}"}\n`
			});
		} finally {
			await rm(files.directory, { recursive: true, force: true });
		}
	});

	it('signs the provenance alone when the run recorded no origin', async () => {
		const files = await workspace();
		const records: SigningRecord[] = [];

		try {
			await attestSignAction(
				options(files, { predicateFile: '', predicateType: '' }),
				{ GITHUB_OUTPUT: files.outputFile },
				createGithubReporter(),
				recordingSigner(records)
			);

			expect({
				predicateTypes: records.map((record) => record.statement.predicateType),
				outputs: await outputsOf(files.outputFile)
			}).toStrictEqual({
				predicateTypes: ['https://slsa.dev/provenance/v1'],
				outputs: {
					'bundle-path': path.join(files.directory, 'provenance.sigstore.json'),
					'origin-bundle-path': ''
				}
			});
		} finally {
			await rm(files.directory, { recursive: true, force: true });
		}
	});

	it('refuses a checksums file that names no subject', async () => {
		const files = await workspace();

		try {
			await writeFile(files.checksumsFile, '');
			await expect(
				attestSignAction(
					options(files),
					{ GITHUB_OUTPUT: files.outputFile },
					createGithubReporter(),
					recordingSigner([])
				)
			).rejects.toBeInstanceOf(InvalidInputError);
		} finally {
			await rm(files.directory, { recursive: true, force: true });
		}
	});

	it('refuses a predicate file that is not a JSON object before signing', async () => {
		const files = await workspace();
		const records: SigningRecord[] = [];

		try {
			await writeFile(files.predicateFile, '["not an object"]\n');
			await expect(
				attestSignAction(
					options(files),
					{ GITHUB_OUTPUT: files.outputFile },
					createGithubReporter(),
					recordingSigner(records)
				)
			).rejects.toBeInstanceOf(AttestationPredicateFileError);

			expect(records).toStrictEqual([]);
		} finally {
			await rm(files.directory, { recursive: true, force: true });
		}
	});

	it('fails the step when a statement cannot be signed', async () => {
		const files = await workspace();
		const records: SigningRecord[] = [];
		const dependencies = recordingSigner(records, [
			new Error('the OIDC token is missing')
		]);

		try {
			await expect(
				attestSignAction(
					options(files),
					{ GITHUB_OUTPUT: files.outputFile },
					createGithubReporter(),
					dependencies
				)
			).rejects.toBeInstanceOf(AttestationSigningError);

			expect({
				attempted: records.length,
				wroteOutputs: existsSync(files.outputFile)
			}).toStrictEqual({ attempted: 1, wroteOutputs: false });
		} finally {
			await rm(files.directory, { recursive: true, force: true });
		}
	});
});
