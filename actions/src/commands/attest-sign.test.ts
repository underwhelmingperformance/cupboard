import path from 'node:path';

import { maxAttestationBundleBytes } from '@cupboard/protocol/attestations';
import { buildOriginPredicateType } from '@cupboard/protocol/build-origin';
import {
	reproducibleAttribute,
	scaiAttributeReportSchema,
	scaiPredicateType
} from '@cupboard/protocol/scai';
import { createGithubReporter, type Reporter } from '@cupboard/reporter';
import { describe, expect, it, vi } from 'vitest';

import type {
	AttestationStatement,
	AttestationSubject,
	BundleEvidence,
	SignedAttestation,
	SigningPolicy
} from '../attestation-signing.ts';
import {
	AttestationBundleTooLargeForSubjectError,
	AttestationPredicateFileError,
	AttestationSigningError,
	AttestationSubjectNotAcceptedError,
	AttestationSubjectsMissingError,
	BooleanInputInvalidError,
	BuildOriginSubjectMissingError,
	ChoiceInputInvalidError,
	MissingInputError,
	PredicateGroupingUnsupportedError,
	PredicateSourceConflictError,
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

function builtOrigin(name: string, narHash: string) {
	return {
		origin: 'built',
		storePath: `/nix/store/${name}`,
		narHash,
		derivation: `/nix/store/${name}.drv`,
		buildStore: 'auto',
		verification: 'build-store'
	};
}

const runOriginPredicate = {
	subjects: [
		builtOrigin(appName, appDigest),
		builtOrigin(runtimeName, runtimeDigest)
	]
};

const reproductionAssertion = {
	attribute: reproducibleAttribute,
	target: { name: appName, digest: { sha256: appDigest } },
	conditions: { derivation: `/nix/store/${appName}.drv` }
};

const inheritedAssertion = {
	attribute: 'ATTESTED_DEPENDENCIES',
	target: { name: runtimeName, digest: { sha256: runtimeDigest } },
	evidence: {
		digest: { sha256: '33'.repeat(32) },
		downloadLocation:
			'https://cache.example.test/t/acme/cache/builds/attestation-bundles/' +
			'33'.repeat(32),
		mediaType: 'application/vnd.dev.sigstore.bundle+json',
		annotations: { predicateType: 'https://slsa.dev/provenance/v1' }
	}
};

interface SigningRecord {
	readonly subjects: readonly AttestationSubject[];
	readonly statement: AttestationStatement;
	readonly policy: SigningPolicy;
}

const publicPolicy: SigningPolicy = {
	profile: 'sigstore-default',
	uploadToGithub: true,
	grouping: 'run'
};

const privatePolicy: SigningPolicy = {
	profile: 'tsa-only',
	uploadToGithub: false,
	grouping: 'individual'
};

// The evidence each profile promises: `tsa-only` a timestamp and no Rekor
// entry, `rekor-and-tsa` both, and `sigstore-default` whatever the instance the
// repository's visibility selects produces.
function signedEvidence(policy: SigningPolicy): BundleEvidence {
	if (policy.profile === 'tsa-only') {
		return { tlogEntryCount: 0, timestampCount: 1 };
	}

	return {
		tlogEntryCount: 1,
		timestampCount: policy.profile === 'rekor-and-tsa' ? 1 : 0
	};
}

interface Workspace {
	readonly directory: string;
	readonly checksumsFile: string;
	readonly signedChecksumsFile: string;
	readonly builtChecksumsFile: string;
	readonly predicateFile: string;
	readonly textFiles: Map<string, string>;
	readonly bundles: Map<string, string>;
}

function workspace(): Workspace {
	const directory = '/runner/temp/cupboard-sign';
	const checksumsFile = path.join(directory, 'subjects.txt');
	const signedChecksumsFile = path.join(directory, 'signed-subjects.txt');
	const builtChecksumsFile = path.join(directory, 'built-subjects.txt');
	const predicateFile = path.join(directory, 'build-origin.json');

	return {
		directory,
		checksumsFile,
		signedChecksumsFile,
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
		writeText(filePath, contents) {
			files.textFiles.set(filePath, contents);
			return Promise.resolve();
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
		destinationAccess: 'public',
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
		signerFor:
			({ subjects, policy }) =>
			(statement) => {
				const failure = failures[records.length];
				records.push({ subjects, statement, policy });

				return failure === undefined
					? Promise.resolve({
							bundle: `{"predicateType":"${statement.predicateType}"}\n`,
							evidence: signedEvidence(policy),
							...(policy.uploadToGithub && {
								attestationId: String(records.length)
							})
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

function ignore(): void {
	return;
}

function oversizedSignedBundle(): Promise<SignedAttestation> {
	return Promise.resolve({
		bundle: 'x'.repeat(maxAttestationBundleBytes + 1),
		evidence: { tlogEntryCount: 1, timestampCount: 0 }
	});
}

const oversizedSigner: NonNullable<AttestSignDependencies['signerFor']> = () =>
	oversizedSignedBundle;

function recordingReporter(reported: string[]): Reporter {
	return {
		phase: (_label, body) =>
			Promise.resolve(body({ fact: ignore, warn: ignore })),
		progress: (_label, _options, body) =>
			Promise.resolve(body({ advance: ignore, fact: ignore, warn: ignore })),
		steps: (_label, body) =>
			Promise.resolve(
				body({
					message: ignore,
					group: () => ({
						message: ignore,
						success: ignore,
						error: ignore
					}),
					warn: ignore
				})
			),
		result: ignore,
		data: ignore,
		error: ignore,
		warn: ignore,
		success: ignore,
		step: ignore,
		info(message) {
			reported.push(message);
		}
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
	it('rejects competing generated and supplied predicate sources', () => {
		const files = workspace();
		expect(() =>
			resolveAttestSignInputs(
				options(files, { receiptFile: '/runner/temp/receipt.json' })
			)
		).toThrow(new PredicateSourceConflictError());
	});

	it('writes default signing outputs in the selected output directory', () => {
		expect(
			resolveAttestSignInputs({
				checksumsFile: '/runner/temp/inputs/subjects.txt',
				builtChecksumsFile: '/runner/temp/inputs/built-subjects.txt',
				outputDirectory: '/runner/temp/signing/first',
				inlineBundles: 'false',
				githubToken: 'token',
				destinationAccess: 'public'
			})
		).toStrictEqual({
			receiptFile: '',
			shouldEmitInlineBundles: false,
			checksumsFile: '/runner/temp/inputs/subjects.txt',
			builtChecksumsFile: '/runner/temp/inputs/built-subjects.txt',
			signedChecksumsFile: '/runner/temp/signing/first/signed-subjects.txt',
			predicateFile: '',
			predicateType: '',
			githubToken: 'token',
			policy: publicPolicy,
			bundleFile: '/runner/temp/signing/first/provenance.sigstore.json',
			originBundleFile: '/runner/temp/signing/first/build-origin.sigstore.json',
			bundlesFile: '/runner/temp/signing/first/bundles.txt'
		});
	});

	it('defaults both bundle paths to the checksums file directory', () => {
		expect(
			resolveAttestSignInputs({
				checksumsFile: '/runner/temp/attestations/subjects.txt',
				builtChecksumsFile: '/runner/temp/attestations/built-subjects.txt',
				predicateFile: '/runner/temp/attestations/build-origin.json',
				predicateType: buildOriginPredicateType,
				githubToken: 'token',
				destinationAccess: 'public'
			})
		).toStrictEqual({
			receiptFile: '',
			shouldEmitInlineBundles: true,
			signedChecksumsFile: '/runner/temp/attestations/signed-subjects.txt',
			bundlesFile: '',
			checksumsFile: '/runner/temp/attestations/subjects.txt',
			builtChecksumsFile: '/runner/temp/attestations/built-subjects.txt',
			predicateFile: '/runner/temp/attestations/build-origin.json',
			predicateType: buildOriginPredicateType,
			githubToken: 'token',
			policy: publicPolicy,
			bundleFile: '/runner/temp/attestations/provenance.sigstore.json',
			originBundleFile: '/runner/temp/attestations/build-origin.sigstore.json'
		});
	});

	const signingInputs = {
		checksumsFile: '/runner/temp/attestations/subjects.txt',
		builtChecksumsFile: '/runner/temp/attestations/built-subjects.txt',
		githubToken: 'token'
	};

	it.each([
		{
			given: { destinationAccess: 'public' },
			expected: publicPolicy
		},
		{
			given: { destinationAccess: 'private' },
			expected: privatePolicy
		},
		{
			given: {},
			expected: privatePolicy
		},
		{
			given: {
				destinationAccess: 'private',
				signingProfile: 'rekor-and-tsa'
			},
			expected: {
				profile: 'rekor-and-tsa',
				uploadToGithub: false,
				grouping: 'individual'
			}
		},
		{
			given: { destinationAccess: 'private', uploadToGithub: 'true' },
			expected: {
				profile: 'tsa-only',
				uploadToGithub: true,
				grouping: 'individual'
			}
		},
		{
			given: { destinationAccess: 'public', signingProfile: 'tsa-only' },
			expected: { profile: 'tsa-only', uploadToGithub: true, grouping: 'run' }
		},
		{
			given: { destinationAccess: 'public', uploadToGithub: 'false' },
			expected: {
				profile: 'sigstore-default',
				uploadToGithub: false,
				grouping: 'run'
			}
		},
		{
			given: { destinationAccess: 'public', subjectGrouping: 'individual' },
			expected: {
				profile: 'sigstore-default',
				uploadToGithub: true,
				grouping: 'individual'
			}
		},
		{
			given: {
				destinationAccess: '',
				signingProfile: '',
				uploadToGithub: ''
			},
			expected: privatePolicy
		}
	])('resolves the policy for $given', ({ given, expected }) => {
		expect(
			resolveAttestSignInputs({ ...signingInputs, ...given }).policy
		).toStrictEqual(expected);
	});

	it.each([
		{
			input: 'signing-profile',
			given: { signingProfile: 'tsa' },
			expected: ChoiceInputInvalidError
		},
		{
			input: 'destination-access',
			given: { destinationAccess: 'internal' },
			expected: ChoiceInputInvalidError
		},
		{
			input: 'upload-to-github',
			given: { uploadToGithub: 'yes' },
			expected: BooleanInputInvalidError
		},
		{
			input: 'subject-grouping',
			given: { subjectGrouping: 'per-subject' },
			expected: ChoiceInputInvalidError
		}
	])('refuses an unknown $input value', ({ given, expected }) => {
		expect(() =>
			resolveAttestSignInputs({ ...signingInputs, ...given })
		).toThrow(expected);
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
			['origin-bundle-path', ''],
			['bundles', `${firstBundle}\n${secondBundle}`],
			['checksums-file', files.signedChecksumsFile]
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
					},
					policy: publicPolicy
				},
				{
					subjects: [
						{ name: appName, sha256: appDigest },
						{ name: runtimeName, sha256: runtimeDigest }
					],
					statement: {
						predicateType: buildOriginPredicateType,
						predicate: originPredicate
					},
					policy: publicPolicy
				}
			],
			outputs: {
				'bundle-path': bundleFile,
				'origin-bundle-path': originBundleFile,
				bundles: `${bundleFile}\n${originBundleFile}`,
				'checksums-file': files.signedChecksumsFile
			},
			bundles: [
				[bundleFile, '{"predicateType":"https://slsa.dev/provenance/v1"}\n'],
				[originBundleFile, `{"predicateType":"${buildOriginPredicateType}"}\n`]
			]
		});
	});

	it.each([
		{ attributes: [reproductionAssertion] },
		{
			attributes: [
				{ attribute: 'WITH_STACK_PROTECTION', exampleExtension: true }
			],
			producer: { uri: 'https://example.test/compiler' },
			exampleExtension: 'preserved'
		},
		{
			attributes: [
				{
					...inheritedAssertion,
					target: { uri: 'https://example.test/dependency' }
				}
			]
		},
		{
			attributes: [
				{
					...reproductionAssertion,
					target: { name: appName, digest: { sha256: runtimeDigest } }
				},
				reproductionAssertion
			]
		}
	])(
		'signs supplied SCAI for explicitly selected subjects: %j',
		async (report) => {
			const files = workspace();
			const records: SigningRecord[] = [];
			const signing = recordedSigning(files, records);
			const bundleFile = path.join(files.directory, 'provenance.sigstore.json');
			const reportBundleFile = path.join(
				files.directory,
				'build-origin.sigstore.json'
			);
			files.textFiles.set(files.predicateFile, `${JSON.stringify(report)}\n`);

			await attestSignAction(
				options(files, { predicateType: scaiPredicateType }),
				createGithubReporter(),
				signing.dependencies
			);

			expect({
				records,
				outputs: signing.outputs,
				signedChecksums: files.textFiles.get(files.signedChecksumsFile)
			}).toStrictEqual({
				records: [
					{
						subjects: [{ name: appName, sha256: appDigest }],
						statement: {
							predicateType: 'https://slsa.dev/provenance/v1',
							predicate: { buildDefinition: { buildType: 'workflow' } }
						},
						policy: publicPolicy
					},
					{
						subjects: [
							{ name: appName, sha256: appDigest },
							{ name: runtimeName, sha256: runtimeDigest }
						],
						statement: {
							predicateType: scaiPredicateType,
							predicate: report
						},
						policy: publicPolicy
					}
				],
				signedChecksums: `${appDigest}  ${appName}\n${runtimeDigest}  ${runtimeName}\n`,
				outputs: {
					'bundle-path': bundleFile,
					'origin-bundle-path': reportBundleFile,
					bundles: `${bundleFile}\n${reportBundleFile}`,
					'checksums-file': files.signedChecksumsFile
				}
			});
		}
	);

	it('signs generated reproduction reports from receipt evidence under individual grouping', async () => {
		const files = workspace();
		const records: SigningRecord[] = [];
		const signing = recordedSigning(files, records);
		const receiptFile = path.join(files.directory, 'receipt.json');
		files.textFiles.set(
			receiptFile,
			JSON.stringify({
				version: 3,
				paths: [`/nix/store/${appName}`, `/nix/store/${runtimeName}`],
				subjects: [
					builtOrigin(appName, appDigest),
					builtOrigin(runtimeName, runtimeDigest)
				].map((subject) => ({
					...subject,
					verification: 'local',
					reproduced: true
				}))
			})
		);

		await attestSignAction(
			options(files, {
				receiptFile,
				predicateFile: '',
				predicateType: '',
				destinationAccess: 'private'
			}),
			createGithubReporter(),
			signing.dependencies
		);

		expect({
			records,
			signedChecksums: files.textFiles.get(files.signedChecksumsFile)
		}).toStrictEqual({
			records: [
				{
					subjects: [{ name: appName, sha256: appDigest }],
					statement: {
						predicateType: 'https://slsa.dev/provenance/v1',
						predicate: { buildDefinition: { buildType: 'workflow' } }
					},
					policy: privatePolicy
				},
				{
					subjects: [{ name: appName, sha256: appDigest }],
					statement: {
						predicateType: scaiPredicateType,
						predicate: {
							attributes: [
								{
									attribute: reproducibleAttribute,
									conditions: reproductionAssertion.conditions
								}
							]
						}
					},
					policy: privatePolicy
				},
				{
					subjects: [{ name: runtimeName, sha256: runtimeDigest }],
					statement: {
						predicateType: scaiPredicateType,
						predicate: {
							attributes: [
								{
									attribute: reproducibleAttribute,
									conditions: { derivation: `/nix/store/${runtimeName}.drv` }
								}
							]
						}
					},
					policy: privatePolicy
				}
			],
			signedChecksums: `${appDigest}  ${appName}\n${runtimeDigest}  ${runtimeName}\n`
		});
	});

	it('refuses ambiguous partitioning of supplied multi-subject SCAI before signing', async () => {
		const files = workspace();
		const records: SigningRecord[] = [];
		const signing = recordedSigning(files, records);
		files.textFiles.set(
			files.predicateFile,
			`${JSON.stringify({
				attributes: [
					{
						attribute: reproducibleAttribute,
						target: {
							name: '2123456789abcdfghijklmnpqrsvwxyz-missing',
							digest: { sha256: '44'.repeat(32) }
						}
					}
				]
			})}\n`
		);

		await expect(
			attestSignAction(
				options(files, {
					predicateType: scaiPredicateType,
					subjectGrouping: 'individual'
				}),
				createGithubReporter(),
				signing.dependencies
			)
		).rejects.toBeInstanceOf(PredicateGroupingUnsupportedError);
		expect(records).toStrictEqual([]);
	});

	it('partitions generated reproduction assertions with their subject batches', async () => {
		const files = workspace();
		const records: SigningRecord[] = [];
		const signing = recordedSigning(files, records);
		const subjects = Array.from({ length: 1025 }, (_, index) => ({
			name: `${String(index).padStart(32, '0')}-app`,
			sha256: index.toString(16).padStart(64, '0')
		}));
		const receiptFile = path.join(files.directory, 'receipt.json');
		files.textFiles.set(
			files.checksumsFile,
			subjects.map((subject) => `${subject.sha256}  ${subject.name}\n`).join('')
		);
		files.textFiles.set(files.builtChecksumsFile, '');
		files.textFiles.set(
			receiptFile,
			JSON.stringify({
				version: 3,
				paths: subjects.map((subject) => `/nix/store/${subject.name}`),
				subjects: subjects.map((subject) => ({
					...builtOrigin(subject.name, subject.sha256),
					verification: 'local',
					reproduced: true
				}))
			})
		);

		await attestSignAction(
			options(files, {
				receiptFile,
				predicateFile: '',
				predicateType: ''
			}),
			recordingReporter([]),
			signing.dependencies
		);

		const groups = [subjects.slice(0, 1024), subjects.slice(1024)];
		expect(records).toStrictEqual(
			groups.map((group) => ({
				subjects: group,
				policy: publicPolicy,
				statement: {
					predicateType: scaiPredicateType,
					predicate: {
						attributes: group.map((subject) => ({
							attribute: reproducibleAttribute,
							...(group.length > 1 && {
								target: {
									name: subject.name,
									digest: { sha256: subject.sha256 }
								}
							}),
							conditions: { derivation: `/nix/store/${subject.name}.drv` }
						}))
					}
				}
			}))
		);
	});

	it('partitions a large single-subject SCAI report without changing evidence or extensions', async () => {
		const files = workspace();
		const records: SigningRecord[] = [];
		const signing = recordedSigning(files, records);
		const subject = { name: appName, sha256: appDigest };
		const attributes = Array.from({ length: 8 }, (_, index) => ({
			attribute: `CHECK_${String(index)}`,
			target: { uri: `https://example.test/dependency/${String(index)}` },
			conditions: { configuration: 'x'.repeat(150_000) },
			evidence: { uri: `https://example.test/evidence/${String(index)}` },
			exampleExtension: index
		}));
		const producer = { uri: 'https://example.test/producer' };
		files.textFiles.set(files.checksumsFile, `${appDigest}  ${appName}\n`);
		files.textFiles.set(files.builtChecksumsFile, '');
		files.textFiles.set(
			files.predicateFile,
			JSON.stringify({ attributes, producer, exampleExtension: true })
		);

		await attestSignAction(
			options(files, { predicateType: scaiPredicateType }),
			recordingReporter([]),
			signing.dependencies
		);

		expect(records).toStrictEqual(
			[attributes.slice(0, 4), attributes.slice(4)].map((partition) => ({
				subjects: [subject],
				policy: publicPolicy,
				statement: {
					predicateType: scaiPredicateType,
					predicate: { attributes: partition, producer, exampleExtension: true }
				}
			}))
		);
	});

	it('partitions single-subject assertions when the signed bundle exceeds the byte limit', async () => {
		const files = workspace();
		const records: SigningRecord[] = [];
		const signing = recordedSigning(files, records);
		const subject = { name: appName, sha256: appDigest };
		const attributes = [{ attribute: 'CHECK_A' }, { attribute: 'CHECK_B' }];
		files.textFiles.set(files.checksumsFile, `${appDigest}  ${appName}\n`);
		files.textFiles.set(files.builtChecksumsFile, '');
		files.textFiles.set(files.predicateFile, JSON.stringify({ attributes }));

		await attestSignAction(
			options(files, { predicateType: scaiPredicateType }),
			recordingReporter([]),
			{
				...signing.dependencies,
				signerFor:
					({ subjects, policy }) =>
					(statement) => {
						records.push({ subjects, policy, statement });
						const report = scaiAttributeReportSchema.parse(statement.predicate);
						return Promise.resolve({
							bundle:
								report.attributes.length > 1
									? 'x'.repeat(maxAttestationBundleBytes + 1)
									: JSON.stringify(statement),
							evidence: signedEvidence(policy)
						});
					}
			}
		);

		expect(records).toStrictEqual(
			[attributes, attributes.slice(0, 1), attributes.slice(1)].map(
				(partition) => ({
					subjects: [subject],
					policy: publicPolicy,
					statement: {
						predicateType: scaiPredicateType,
						predicate: { attributes: partition }
					}
				})
			)
		);
		expect(
			files.bundles
				.values()
				.map((bundle): unknown => JSON.parse(bundle))
				.toArray()
		).toStrictEqual(
			attributes.map((attribute) => ({
				predicateType: scaiPredicateType,
				predicate: { attributes: [attribute] }
			}))
		);
	});

	it('signs the provenance alone when no custom predicate is supplied', async () => {
		const files = workspace();
		const records: SigningRecord[] = [];
		const signing = recordedSigning(files, records);

		await attestSignAction(
			options(files, { predicateFile: '', predicateType: '' }),
			createGithubReporter(),
			signing.dependencies
		);

		expect({
			records,
			outputs: signing.outputs,
			signedChecksums: files.textFiles.get(files.signedChecksumsFile)
		}).toStrictEqual({
			records: [
				{
					subjects: [{ name: appName, sha256: appDigest }],
					statement: {
						predicateType: 'https://slsa.dev/provenance/v1',
						predicate: { buildDefinition: { buildType: 'workflow' } }
					},
					policy: publicPolicy
				}
			],
			signedChecksums: `${appDigest}  ${appName}\n`,
			outputs: {
				'bundle-path': path.join(files.directory, 'provenance.sigstore.json'),
				'origin-bundle-path': '',
				bundles: path.join(files.directory, 'provenance.sigstore.json'),
				'checksums-file': files.signedChecksumsFile
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
				),
				bundles: path.join(files.directory, 'build-origin.sigstore.json'),
				'checksums-file': files.signedChecksumsFile
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
				'origin-bundle-path': `${firstOriginBundle}\n${secondOriginBundle}`,
				bundles: [
					firstProvenanceBundle,
					secondProvenanceBundle,
					firstOriginBundle,
					secondOriginBundle
				].join('\n'),
				'checksums-file': files.signedChecksumsFile
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

	it.each([
		{
			destination: 'private',
			given: {},
			disclosed: [
				'Signing with the public-good Sigstore instance.',
				'Signing SLSA build provenance for 1 built path, one statement per path. Each bundle will contain one subject.',
				'Signing custom predicate for 2 accepted paths, one statement per path. Each bundle will contain one subject.',
				'Signing can contact the following external services.',
				'  OIDC and Fulcio receive the workload identity and an ephemeral public key.',
				'  Certificate transparency receives the signing certificate and the identity it certifies.',
				'  An RFC 3161 timestamp authority receives the signature imprint and returns a signed timestamp.',
				'Signing publishes evidence or complete bundles to the following destinations.',
				'  The action writes the complete bundle to files on the runner. Attaching one to the destination cache makes it readable under the read policy of that cache.'
			],
			produced: [
				'The bundles are in the trust domain of the public-good Sigstore instance.',
				'The action signed 3 bundles that carry 0 Rekor entries and 3 RFC 3161 timestamps.',
				"The action recorded no bundle in the repository's attestation store."
			]
		},
		{
			destination: 'private with an explicit public-good profile',
			given: {
				signingProfile: 'rekor-and-tsa',
				uploadToGithub: 'true'
			},
			disclosed: [
				'Signing with the public-good Sigstore instance.',
				'Signing SLSA build provenance for 1 built path, one statement per path. Each bundle will contain one subject.',
				'Signing custom predicate for 2 accepted paths, one statement per path. Each bundle will contain one subject.',
				'Signing can contact the following external services.',
				'  OIDC and Fulcio receive the workload identity and an ephemeral public key.',
				'  Certificate transparency receives the signing certificate and the identity it certifies.',
				'  An RFC 3161 timestamp authority receives the signature imprint and returns a signed timestamp.',
				'  Rekor receives the signed statement, its signature and the signing certificate.',
				'Signing publishes evidence or complete bundles to the following destinations.',
				'  Rekor stores a permanent public record of the signature, and that record remains after the cache drops the path.',
				"  The action writes the complete bundle to the repository's attestation store, where every reader of the repository can read it.",
				'  The action writes the complete bundle to files on the runner. Attaching one to the destination cache makes it readable under the read policy of that cache.'
			],
			produced: [
				'The bundles are in the trust domain of the public-good Sigstore instance.',
				'The action signed 3 bundles that carry 3 Rekor entries and 3 RFC 3161 timestamps.',
				"The action recorded 3 of 3 bundles in the repository's attestation store."
			]
		}
	])(
		'discloses the services a $destination destination contacts before signing',
		async ({ given, disclosed, produced }) => {
			const files = workspace();
			const reported: string[] = [];

			files.textFiles.set(
				files.predicateFile,
				`${JSON.stringify(runOriginPredicate)}\n`
			);
			await attestSignAction(
				options(files, { destinationAccess: 'private', ...given }),
				recordingReporter(reported),
				recordedSigning(files, []).dependencies
			);

			expect(reported).toStrictEqual([...disclosed, ...produced]);
		}
	);

	it('signs one statement per subject under individual grouping', async () => {
		const files = workspace();
		const records: SigningRecord[] = [];
		const signing = recordedSigning(files, records);
		const bothSubjects = `${appDigest}  ${appName}\n${runtimeDigest}  ${runtimeName}\n`;

		files.textFiles.set(files.builtChecksumsFile, bothSubjects);
		files.textFiles.set(
			files.predicateFile,
			`${JSON.stringify(runOriginPredicate)}\n`
		);

		await attestSignAction(
			options(files, { destinationAccess: 'private' }),
			createGithubReporter(),
			signing.dependencies
		);

		expect({
			signed: records.map((record) => ({
				subjects: record.subjects,
				predicateType: record.statement.predicateType,
				predicate: record.statement.predicate
			})),
			outputs: signing.outputs
		}).toStrictEqual({
			signed: [
				{
					subjects: [{ name: appName, sha256: appDigest }],
					predicateType: 'https://slsa.dev/provenance/v1',
					predicate: { buildDefinition: { buildType: 'workflow' } }
				},
				{
					subjects: [{ name: runtimeName, sha256: runtimeDigest }],
					predicateType: 'https://slsa.dev/provenance/v1',
					predicate: { buildDefinition: { buildType: 'workflow' } }
				},
				{
					subjects: [{ name: appName, sha256: appDigest }],
					predicateType: buildOriginPredicateType,
					predicate: { subjects: [builtOrigin(appName, appDigest)] }
				},
				{
					subjects: [{ name: runtimeName, sha256: runtimeDigest }],
					predicateType: buildOriginPredicateType,
					predicate: { subjects: [builtOrigin(runtimeName, runtimeDigest)] }
				}
			],
			outputs: {
				'bundle-path': [
					path.join(files.directory, 'provenance.sigstore.json'),
					path.join(files.directory, 'provenance.sigstore.2.json')
				].join('\n'),
				'origin-bundle-path': [
					path.join(files.directory, 'build-origin.sigstore.json'),
					path.join(files.directory, 'build-origin.sigstore.2.json')
				].join('\n'),
				bundles: [
					path.join(files.directory, 'provenance.sigstore.json'),
					path.join(files.directory, 'provenance.sigstore.2.json'),
					path.join(files.directory, 'build-origin.sigstore.json'),
					path.join(files.directory, 'build-origin.sigstore.2.json')
				].join('\n'),
				'checksums-file': files.signedChecksumsFile
			}
		});
	});

	it('keeps same-digest subjects separate under individual grouping', async () => {
		const files = workspace();
		const records: SigningRecord[] = [];
		const signing = recordedSigning(files, records);
		const bothSubjects = `${appDigest}  ${appName}\n${appDigest}  ${runtimeName}\n`;

		files.textFiles.set(files.checksumsFile, bothSubjects);
		files.textFiles.set(files.builtChecksumsFile, '');
		files.textFiles.set(
			files.predicateFile,
			`${JSON.stringify({
				subjects: [
					builtOrigin(appName, appDigest),
					builtOrigin(runtimeName, appDigest)
				]
			})}\n`
		);

		await attestSignAction(
			options(files, { destinationAccess: 'private' }),
			createGithubReporter(),
			signing.dependencies
		);

		expect(
			records.map((record) => ({
				subjects: record.subjects,
				predicate: record.statement.predicate
			}))
		).toStrictEqual([
			{
				subjects: [{ name: appName, sha256: appDigest }],
				predicate: { subjects: [builtOrigin(appName, appDigest)] }
			},
			{
				subjects: [{ name: runtimeName, sha256: appDigest }],
				predicate: { subjects: [builtOrigin(runtimeName, appDigest)] }
			}
		]);
	});

	it('refuses individual grouping for a predicate it cannot project', async () => {
		const files = workspace();
		const records: SigningRecord[] = [];
		const signing = recordedSigning(files, records);

		await expect(
			attestSignAction(
				options(files, {
					destinationAccess: 'private',
					predicateType: 'https://spdx.dev/Document'
				}),
				createGithubReporter(),
				signing.dependencies
			)
		).rejects.toBeInstanceOf(PredicateGroupingUnsupportedError);

		expect(records).toStrictEqual([]);
	});

	it('refuses a subject the build-origin predicate does not record', async () => {
		const files = workspace();
		const records: SigningRecord[] = [];
		const signing = recordedSigning(files, records);

		files.textFiles.set(
			files.predicateFile,
			`${JSON.stringify({ subjects: [builtOrigin(appName, appDigest)] })}\n`
		);

		await expect(
			attestSignAction(
				options(files, { destinationAccess: 'private' }),
				createGithubReporter(),
				signing.dependencies
			)
		).rejects.toBeInstanceOf(BuildOriginSubjectMissingError);

		expect(records).toStrictEqual([]);
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
	it('writes a bundle manifest and keeps small legacy outputs', async () => {
		const files = workspace();
		const records: SigningRecord[] = [];
		const signing = recordedSigning(files, records);
		const bundlesFile = path.join(files.directory, 'bundles.txt');
		const checksums = `${checksumLines(1025)}\n`;
		files.textFiles.set(files.checksumsFile, checksums);
		files.textFiles.set(files.builtChecksumsFile, checksums);

		await attestSignAction(
			options(files, {
				predicateFile: '',
				predicateType: '',
				bundlesFile
			}),
			createGithubReporter(),
			signing.dependencies
		);

		expect({
			outputs: signing.outputs,
			manifest: files.textFiles.get(bundlesFile)
		}).toStrictEqual({
			outputs: {
				'bundle-path':
					path.join(files.directory, 'provenance.sigstore.json') +
					'\n' +
					path.join(files.directory, 'provenance.sigstore.2.json'),
				'origin-bundle-path': '',
				bundles:
					path.join(files.directory, 'provenance.sigstore.json') +
					'\n' +
					path.join(files.directory, 'provenance.sigstore.2.json'),
				'bundles-file': bundlesFile,
				'checksums-file': files.signedChecksumsFile
			},
			manifest:
				`${path.join(files.directory, 'provenance.sigstore.json')}\n` +
				`${path.join(files.directory, 'provenance.sigstore.2.json')}\n`
		});
	});

	it.each([
		{ inlineBundles: undefined, explicitManifest: true },
		{ inlineBundles: 'false', explicitManifest: true },
		{ inlineBundles: 'false', explicitManifest: false }
	])(
		'keeps large bundle lists complete with $inlineBundles inline output and explicit manifest $explicitManifest',
		async ({ inlineBundles, explicitManifest }) => {
			const files = workspace();
			const records: SigningRecord[] = [];
			const signing = recordedSigning(files, records);
			const checksums = `${checksumLines(600)}\n`;
			const bundlesFile = path.join(files.directory, 'bundles.txt');
			const bundlePaths = Array.from({ length: 600 }, (_, index) =>
				path.join(
					files.directory,
					index === 0
						? 'provenance.sigstore.json'
						: `provenance.sigstore.${String(index + 1)}.json`
				)
			);
			const bundleList = bundlePaths.join('\n');
			files.textFiles.set(files.checksumsFile, checksums);
			files.textFiles.set(files.builtChecksumsFile, checksums);

			await attestSignAction(
				options(files, {
					predicateFile: '',
					predicateType: '',
					destinationAccess: 'private',
					inlineBundles,
					...(explicitManifest && { bundlesFile })
				}),
				createGithubReporter(),
				signing.dependencies
			);

			expect({
				outputs: signing.outputs,
				bundles: files.bundles.keys().toArray(),
				manifest: files.textFiles.get(bundlesFile)
			}).toStrictEqual({
				outputs: {
					...(inlineBundles !== 'false' && {
						'bundle-path': bundleList,
						bundles: bundleList
					}),
					...(inlineBundles !== 'false' && { 'origin-bundle-path': '' }),
					'bundles-file': bundlesFile,
					'checksums-file': files.signedChecksumsFile
				},
				bundles: bundlePaths,
				manifest: `${bundleList}\n`
			});
		}
	);

	it('signs nothing when no path was built', async () => {
		const files = workspace();
		const bundlesFile = path.join(files.directory, 'bundles.txt');
		const records: SigningRecord[] = [];
		const signing = recordedSigning(files, records);
		const reported: string[] = [];
		files.textFiles.set(files.builtChecksumsFile, '');

		await attestSignAction(
			options(files, { predicateFile: '', predicateType: '', bundlesFile }),
			recordingReporter(reported),
			signing.dependencies
		);

		expect({
			records,
			outputs: signing.outputs,
			bundles: [...files.bundles],
			manifest: files.textFiles.get(bundlesFile),
			signedChecksums: files.textFiles.get(files.signedChecksumsFile),
			reported
		}).toStrictEqual({
			records: [],
			outputs: {
				'bundle-path': '',
				'origin-bundle-path': '',
				bundles: '',
				'bundles-file': '',
				'checksums-file': files.signedChecksumsFile
			},
			bundles: [],
			manifest: '',
			signedChecksums: '',
			reported: ['This run signed no statement.']
		});
	});

	it('splits a signed bundle when its witness material exceeds the cache limit', async () => {
		const files = workspace();
		const batches: string[][] = [];
		files.textFiles.set(
			files.builtChecksumsFile,
			`${appDigest}  ${appName}\n${runtimeDigest}  ${runtimeName}\n`
		);

		await attestSignAction(
			options(files, { predicateFile: '', predicateType: '' }),
			createGithubReporter(),
			{
				io: memoryIo(files),
				setOutput: ignore,
				provenanceStatement: () =>
					Promise.resolve({
						predicateType: 'https://slsa.dev/provenance/v1',
						predicate: {}
					}),
				signerFor:
					({ subjects }) =>
					() => {
						batches.push(subjects.map((subject) => subject.name));
						return Promise.resolve({
							bundle: 'x'.repeat(
								subjects.length === 1 ? 1024 : maxAttestationBundleBytes + 1
							),
							evidence: { tlogEntryCount: 1, timestampCount: 0 }
						});
					}
			}
		);

		expect({ batches, bundles: files.bundles.size }).toStrictEqual({
			batches: [[appName, runtimeName], [appName], [runtimeName]],
			bundles: 2
		});
	});

	it('reports a subject whose signed bundle exceeds the cache limit', async () => {
		const files = workspace();

		await expect(
			attestSignAction(
				options(files, { predicateFile: '', predicateType: '' }),
				createGithubReporter(),
				{
					io: memoryIo(files),
					setOutput: ignore,
					provenanceStatement: () =>
						Promise.resolve({
							predicateType: 'https://slsa.dev/provenance/v1',
							predicate: {}
						}),
					signerFor: oversizedSigner
				}
			)
		).rejects.toStrictEqual(
			new AttestationBundleTooLargeForSubjectError(
				appName,
				maxAttestationBundleBytes + 1,
				maxAttestationBundleBytes
			)
		);
		expect(files.bundles.size).toBe(0);
	});

	it('refuses a built subject that is missing from the accepted checksums', async () => {
		const files = workspace();
		const records: SigningRecord[] = [];
		const signing = recordedSigning(files, records);
		files.textFiles.set(
			files.builtChecksumsFile,
			`${runtimeDigest}  ${appName}\n`
		);

		await expect(
			attestSignAction(
				options(files),
				createGithubReporter(),
				signing.dependencies
			)
		).rejects.toBeInstanceOf(AttestationSubjectNotAcceptedError);

		expect(records).toStrictEqual([]);
	});
});
