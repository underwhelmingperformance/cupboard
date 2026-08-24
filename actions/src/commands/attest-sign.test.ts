import path from 'node:path';

import { buildOriginPredicateType } from '@cupboard/protocol/build-origin';
import { createGithubReporter } from '@cupboard/reporter';
import { describe, expect, it, vi } from 'vitest';

import type {
	AttestationStatement,
	AttestationSubject
} from '../attestation-signing.ts';
import {
	AttestationPredicateFileError,
	AttestationSigningError,
	AttestationSubjectsMissingError,
	MissingInputError,
	PredicateTypeRequiredError
} from '../errors.ts';

import {
	attestSignAction,
	type AttestSignDependencies,
	type AttestSignIo,
	type AttestSignOptions,
	resolveAttestSignInputs
} from './attest-sign.ts';

const mocks = vi.hoisted(() => ({ setOutput: vi.fn() }));

vi.mock('@actions/core', () => ({ setOutput: mocks.setOutput }));

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
	readonly builtChecksumsFile: string;
	readonly predicateFile: string;
	readonly textFiles: Map<string, string>;
	readonly bundles: Map<string, string>;
}

function workspace(): Workspace {
	const directory = '/runner/temp/cupboard-sign';
	const checksumsFile = path.join(directory, 'subjects.txt');
	const builtChecksumsFile = path.join(directory, 'built-subjects.txt');
	const predicateFile = path.join(directory, 'build-origin.json');

	return {
		directory,
		checksumsFile,
		builtChecksumsFile,
		predicateFile,
		textFiles: new Map([
			[
				checksumsFile,
				`${appDigest}  ${appName}\n${runtimeDigest}  ${runtimeName}\n`
			],
			[builtChecksumsFile, `${appDigest}  ${appName}\n`],
			[predicateFile, `${JSON.stringify(originPredicate)}\n`]
		]),
		bundles: new Map()
	};
}

function memoryIo(files: Workspace): AttestSignIo {
	return {
		readText(filePath) {
			const contents = files.textFiles.get(filePath);

			return contents === undefined
				? Promise.reject(new Error(`No test file exists at ${filePath}`))
				: Promise.resolve(contents);
		},
		writeBundle(filePath, signed) {
			files.bundles.set(filePath, signed.bundle);

			return Promise.resolve();
		}
	};
}

function options(
	files: Workspace,
	overrides: Partial<AttestSignOptions> = {}
): AttestSignOptions {
	return {
		checksumsFile: files.checksumsFile,
		builtChecksumsFile: files.builtChecksumsFile,
		predicateFile: files.predicateFile,
		predicateType: buildOriginPredicateType,
		githubToken: 'token',
		...overrides
	};
}

interface RecordedSigning {
	readonly dependencies: AttestSignDependencies;
	readonly outputs: Readonly<Record<string, string>>;
}

function recordedSigning(
	files: Workspace,
	records: SigningRecord[],
	failures: readonly Error[] = [],
	shouldRecordOutputs = true
): RecordedSigning {
	const outputs: Record<string, string> = {};
	const dependencies: AttestSignDependencies = {
		io: memoryIo(files),
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

	return {
		outputs,
		dependencies: shouldRecordOutputs
			? {
					...dependencies,
					setOutput(name, value) {
						outputs[name] = value;
					}
				}
			: dependencies
	};
}

function checksumLines(count: number): string {
	return Array.from({ length: count }, (_, index) => {
		const digest = index.toString(16).padStart(64, '0');
		const name = `subject-${String(index).padStart(4, '0')}`;

		return `${digest}  ${name}`;
	}).join('\n');
}

describe('resolveAttestSignInputs', () => {
	it('defaults both bundle paths to the checksums file directory', () => {
		expect(
			resolveAttestSignInputs({
				checksumsFile: '/runner/temp/attestations/subjects.txt',
				builtChecksumsFile: '/runner/temp/attestations/built-subjects.txt',
				predicateFile: '/runner/temp/attestations/build-origin.json',
				predicateType: buildOriginPredicateType,
				githubToken: 'token'
			})
		).toStrictEqual({
			checksumsFile: '/runner/temp/attestations/subjects.txt',
			builtChecksumsFile: '/runner/temp/attestations/built-subjects.txt',
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
			missing: 'built-checksums-file',
			options: {
				checksumsFile: '/runner/temp/subjects.txt',
				githubToken: 'token'
			},
			expected: MissingInputError
		},
		{
			missing: 'github-token',
			options: {
				checksumsFile: '/runner/temp/subjects.txt',
				builtChecksumsFile: '/runner/temp/built-subjects.txt'
			},
			expected: MissingInputError
		},
		{
			missing: 'predicate-type',
			options: {
				checksumsFile: '/runner/temp/subjects.txt',
				builtChecksumsFile: '/runner/temp/built-subjects.txt',
				predicateFile: '/runner/temp/build-origin.json',
				githubToken: 'token'
			},
			expected: PredicateTypeRequiredError
		}
	])('refuses inputs without $missing', ({ options: given, expected }) => {
		expect(() => resolveAttestSignInputs(given)).toThrow(expected);
	});
});

describe('attestSignAction', () => {
	it('writes action outputs through the GitHub Actions toolkit', async () => {
		const files = workspace();
		const records: SigningRecord[] = [];
		const signing = recordedSigning(files, records, [], false);
		const checksums = `${checksumLines(1025)}\n`;
		const firstBundle = path.join(files.directory, 'provenance.sigstore.json');
		const secondBundle = path.join(
			files.directory,
			'provenance.sigstore.2.json'
		);

		files.textFiles.set(files.checksumsFile, checksums);
		files.textFiles.set(files.builtChecksumsFile, checksums);
		mocks.setOutput.mockClear();

		await attestSignAction(
			options(files, { predicateFile: '', predicateType: '' }),
			createGithubReporter(),
			signing.dependencies
		);

		expect(mocks.setOutput.mock.calls).toStrictEqual([
			['bundle-path', `${firstBundle}\n${secondBundle}`],
			['origin-bundle-path', '']
		]);
	});

	it('signs build provenance for built paths and build-origin for all accepted subjects', async () => {
		const files = workspace();
		const records: SigningRecord[] = [];
		const signing = recordedSigning(files, records);
		const bundleFile = path.join(files.directory, 'provenance.sigstore.json');
		const originBundleFile = path.join(
			files.directory,
			'build-origin.sigstore.json'
		);

		await attestSignAction(
			options(files),
			createGithubReporter(),
			signing.dependencies
		);

		expect({
			records,
			outputs: signing.outputs,
			bundles: [...files.bundles]
		}).toStrictEqual({
			records: [
				{
					subjects: [{ name: appName, sha256: appDigest }],
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
			bundles: [
				[bundleFile, '{"predicateType":"https://slsa.dev/provenance/v1"}\n'],
				[originBundleFile, `{"predicateType":"${buildOriginPredicateType}"}\n`]
			]
		});
	});

	it('signs the provenance alone when the run recorded no origin', async () => {
		const files = workspace();
		const records: SigningRecord[] = [];
		const signing = recordedSigning(files, records);

		await attestSignAction(
			options(files, { predicateFile: '', predicateType: '' }),
			createGithubReporter(),
			signing.dependencies
		);

		expect({
			predicateTypes: records.map((record) => record.statement.predicateType),
			outputs: signing.outputs
		}).toStrictEqual({
			predicateTypes: ['https://slsa.dev/provenance/v1'],
			outputs: {
				'bundle-path': path.join(files.directory, 'provenance.sigstore.json'),
				'origin-bundle-path': ''
			}
		});
	});

	it('signs build-origin alone when this run built none of the published paths', async () => {
		const files = workspace();
		const records: SigningRecord[] = [];
		const signing = recordedSigning(files, records);
		files.textFiles.set(files.builtChecksumsFile, '');

		await attestSignAction(
			options(files),
			createGithubReporter(),
			signing.dependencies
		);

		expect({
			predicateTypes: records.map((record) => record.statement.predicateType),
			outputs: signing.outputs
		}).toStrictEqual({
			predicateTypes: [buildOriginPredicateType],
			outputs: {
				'bundle-path': '',
				'origin-bundle-path': path.join(
					files.directory,
					'build-origin.sigstore.json'
				)
			}
		});
	});

	it('splits both statements at the GitHub subject limit', async () => {
		const files = workspace();
		const records: SigningRecord[] = [];
		const signing = recordedSigning(files, records);
		const checksums = `${checksumLines(1025)}\n`;
		const firstProvenanceBundle = path.join(
			files.directory,
			'provenance.sigstore.json'
		);
		const secondProvenanceBundle = path.join(
			files.directory,
			'provenance.sigstore.2.json'
		);
		const firstOriginBundle = path.join(
			files.directory,
			'build-origin.sigstore.json'
		);
		const secondOriginBundle = path.join(
			files.directory,
			'build-origin.sigstore.2.json'
		);

		files.textFiles.set(files.checksumsFile, checksums);
		files.textFiles.set(files.builtChecksumsFile, checksums);
		await attestSignAction(
			options(files),
			createGithubReporter(),
			signing.dependencies
		);

		expect({
			batches: records.map((record) => ({
				count: record.subjects.length,
				first: record.subjects.at(0)?.name,
				last: record.subjects.at(-1)?.name
			})),
			outputs: signing.outputs,
			bundles: [...files.bundles]
		}).toStrictEqual({
			batches: [
				{
					count: 1024,
					first: 'subject-0000',
					last: 'subject-1023'
				},
				{
					count: 1,
					first: 'subject-1024',
					last: 'subject-1024'
				},
				{
					count: 1024,
					first: 'subject-0000',
					last: 'subject-1023'
				},
				{
					count: 1,
					first: 'subject-1024',
					last: 'subject-1024'
				}
			],
			outputs: {
				'bundle-path': `${firstProvenanceBundle}\n${secondProvenanceBundle}`,
				'origin-bundle-path': `${firstOriginBundle}\n${secondOriginBundle}`
			},
			bundles: [
				[
					firstProvenanceBundle,
					'{"predicateType":"https://slsa.dev/provenance/v1"}\n'
				],
				[
					secondProvenanceBundle,
					'{"predicateType":"https://slsa.dev/provenance/v1"}\n'
				],
				[
					firstOriginBundle,
					`{"predicateType":"${buildOriginPredicateType}"}\n`
				],
				[
					secondOriginBundle,
					`{"predicateType":"${buildOriginPredicateType}"}\n`
				]
			]
		});
	});

	it('refuses a checksums file that lists no subject', async () => {
		const files = workspace();
		files.textFiles.set(files.checksumsFile, '');

		await expect(
			attestSignAction(
				options(files),
				createGithubReporter(),
				recordedSigning(files, []).dependencies
			)
		).rejects.toBeInstanceOf(AttestationSubjectsMissingError);
	});

	it('rejects a predicate file that does not contain a JSON object before signing', async () => {
		const files = workspace();
		const records: SigningRecord[] = [];
		const signing = recordedSigning(files, records);
		files.textFiles.set(files.predicateFile, '["not an object"]\n');

		await expect(
			attestSignAction(
				options(files),
				createGithubReporter(),
				signing.dependencies
			)
		).rejects.toBeInstanceOf(AttestationPredicateFileError);

		expect(records).toStrictEqual([]);
	});

	it('fails the step when a statement cannot be signed', async () => {
		const files = workspace();
		const records: SigningRecord[] = [];
		const signing = recordedSigning(files, records, [
			new Error('the OIDC token is missing')
		]);

		await expect(
			attestSignAction(
				options(files),
				createGithubReporter(),
				signing.dependencies
			)
		).rejects.toBeInstanceOf(AttestationSigningError);

		expect({
			attempted: records.length,
			outputs: signing.outputs
		}).toStrictEqual({ attempted: 1, outputs: {} });
	});
});
