import type { AttestOptions, Predicate } from '@actions/attest';
import {
	cacheNameSchema,
	DEFAULT_CACHE,
	privateStoredCache,
	type StoredCache,
	storedCacheSchema
} from '@cupboard/nix-store/scalars';
import { createGithubReporter } from '@cupboard/reporter';
import { describe, expect, it, vi } from 'vitest';

import {
	type AttestationStatement,
	cacheVisibility,
	defaultSigningPolicy,
	type DestinationVisibility,
	disclosureLines,
	githubStatementSigner,
	isTransientSigningFailure,
	maxSigningAttempts,
	producedInstance,
	producedLines,
	type SignedAttestation,
	signingDisclosure,
	type SigningStageCode,
	signStatement,
	slsaProvenanceStatement,
	type StatementSigner
} from './attestation-signing.ts';
import { AttestationSigningError } from './errors.ts';

const mocks = vi.hoisted(() => ({
	attest: vi.fn<(options: AttestOptions) => Promise<unknown>>(),
	buildSLSAProvenancePredicate: vi.fn<() => Promise<Predicate>>()
}));

vi.mock('@actions/attest', () => ({
	attest: mocks.attest,
	buildSLSAProvenancePredicate: mocks.buildSLSAProvenancePredicate
}));

class SigningFailure extends Error {
	constructor(
		public readonly code: SigningStageCode,
		public override readonly cause: unknown
	) {
		super('the signing attempt failed');
		this.name = 'SigningFailure';
	}
}

class HttpFailure extends Error {
	constructor(public readonly statusCode: number) {
		super('the service answered with an error status');
		this.name = 'HttpFailure';
	}
}

function signingFailure(
	code: SigningStageCode,
	cause: unknown = new Error('the connection timed out')
): SigningFailure {
	return new SigningFailure(code, cause);
}

function httpFailure(statusCode: number): HttpFailure {
	return new HttpFailure(statusCode);
}

interface ClassificationCase {
	readonly failure: string;
	readonly error: unknown;
	readonly transient: boolean;
}

const classificationCases: readonly ClassificationCase[] = [
	{
		failure: 'fetching the log entry received no response',
		error: signingFailure('TLOG_FETCH_ENTRY_ERROR'),
		transient: true
	},
	{
		failure: 'the transparency log answered the fetch with 504',
		error: signingFailure('TLOG_FETCH_ENTRY_ERROR', httpFailure(504)),
		transient: true
	},
	{
		failure: 'the transparency log answered entry creation with 500',
		error: signingFailure('TLOG_CREATE_ENTRY_ERROR', httpFailure(500)),
		transient: true
	},
	{
		failure: 'the transparency log refused the new entry with 400',
		error: signingFailure('TLOG_CREATE_ENTRY_ERROR', httpFailure(400)),
		transient: false
	},
	{
		failure: 'Fulcio answered the certificate request with 503',
		error: signingFailure(
			'CA_CREATE_SIGNING_CERTIFICATE_ERROR',
			httpFailure(503)
		),
		transient: true
	},
	{
		failure: 'Fulcio refused the certificate with 403',
		error: signingFailure(
			'CA_CREATE_SIGNING_CERTIFICATE_ERROR',
			httpFailure(403)
		),
		transient: false
	},
	{
		failure: 'the timestamp authority returned no response',
		error: signingFailure('TSA_CREATE_TIMESTAMP_ERROR'),
		transient: true
	},
	{
		failure: 'the OIDC token could not be read',
		error: signingFailure('IDENTITY_TOKEN_READ_ERROR'),
		transient: false
	},
	{
		failure: 'the OIDC token could not be decoded',
		error: signingFailure('IDENTITY_TOKEN_PARSE_ERROR'),
		transient: false
	},
	{
		failure: 'the attestation store refused the bundle',
		error: new Error('the store refused the bundle'),
		transient: false
	},
	{
		failure: 'the code is not a `@sigstore/sign` stage code',
		error: { code: 'DEPLOY_FAILED', cause: new Error('the socket closed') },
		transient: false
	},
	{
		failure: 'the thrown value is not an object',
		error: 'TLOG_FETCH_ENTRY_ERROR',
		transient: false
	}
];

describe('isTransientSigningFailure', () => {
	it.each(classificationCases)(
		'returns $transient when $failure',
		({ error, transient }) => {
			expect(isTransientSigningFailure(error)).toBe(transient);
		}
	);
});

const statement: AttestationStatement = {
	predicateType: 'https://slsa.dev/provenance/v1',
	predicate: { buildDefinition: {} }
};

const signed: SignedAttestation = {
	bundle: '{"mediaType":"test"}\n',
	evidence: { tlogEntryCount: 1, timestampCount: 0 }
};

interface SigningRun {
	readonly signer: StatementSigner;
	readonly attempted: AttestationStatement[];
	readonly delays: number[];
	readonly delay: (attempt: number) => Promise<void>;
}

function signingRun(failures: readonly Error[]): SigningRun {
	const attempted: AttestationStatement[] = [];
	const delays: number[] = [];

	return {
		attempted,
		delays,
		delay: (attempt) => {
			delays.push(attempt);

			return Promise.resolve();
		},
		signer: (given) => {
			const failure = failures[attempted.length];
			attempted.push(given);

			return failure === undefined
				? Promise.resolve(signed)
				: Promise.reject(failure);
		}
	};
}

function sign(run: SigningRun): Promise<SignedAttestation> {
	return signStatement(statement, run.signer, createGithubReporter(), {
		delay: run.delay
	});
}

async function signingError(run: SigningRun): Promise<AttestationSigningError> {
	try {
		await sign(run);
	} catch (error: unknown) {
		if (error instanceof AttestationSigningError) {
			return error;
		}

		throw error;
	}

	throw new Error('signStatement was expected to fail');
}

describe('signStatement', () => {
	it('signs once when the first attempt succeeds', async () => {
		const run = signingRun([]);
		const result = await sign(run);

		expect({
			result,
			attempted: run.attempted,
			delays: run.delays
		}).toStrictEqual({
			result: signed,
			attempted: [statement],
			delays: []
		});
	});

	it('signs again after a transient witness failure', async () => {
		const run = signingRun([
			signingFailure('TLOG_FETCH_ENTRY_ERROR'),
			signingFailure('TLOG_CREATE_ENTRY_ERROR', httpFailure(503))
		]);
		const result = await sign(run);

		expect({
			result,
			attempted: run.attempted,
			delays: run.delays
		}).toStrictEqual({
			result: signed,
			attempted: [statement, statement, statement],
			delays: [1, 2]
		});
	});

	it('fails once the attempts run out', async () => {
		const last = signingFailure('TLOG_FETCH_ENTRY_ERROR');
		const run = signingRun([
			signingFailure('TLOG_FETCH_ENTRY_ERROR'),
			signingFailure('TLOG_FETCH_ENTRY_ERROR'),
			signingFailure('TLOG_FETCH_ENTRY_ERROR'),
			last
		]);
		const error = await signingError(run);

		expect({
			name: error.name,
			predicateType: error.predicateType,
			attempts: error.attempts,
			cause: error.cause,
			attempted: run.attempted.length,
			delays: run.delays
		}).toStrictEqual({
			name: 'AttestationSigningError',
			predicateType: statement.predicateType,
			attempts: maxSigningAttempts,
			cause: last,
			attempted: maxSigningAttempts,
			delays: [1, 2, 3]
		});
	});

	it('does not sign again after a refused certificate', async () => {
		const refused = signingFailure(
			'CA_CREATE_SIGNING_CERTIFICATE_ERROR',
			httpFailure(403)
		);
		const run = signingRun([refused]);
		const error = await signingError(run);

		expect({
			name: error.name,
			predicateType: error.predicateType,
			attempts: error.attempts,
			cause: error.cause,
			attempted: run.attempted.length,
			delays: run.delays
		}).toStrictEqual({
			name: 'AttestationSigningError',
			predicateType: statement.predicateType,
			attempts: 1,
			cause: refused,
			attempted: 1,
			delays: []
		});
	});
});

const visibilityCases: readonly {
	readonly cache: StoredCache;
	readonly expected: DestinationVisibility;
}[] = [
	{ cache: DEFAULT_CACHE, expected: 'public' },
	{ cache: storedCacheSchema.parse('releases'), expected: 'public' },
	{
		cache: privateStoredCache(cacheNameSchema.parse('ci')),
		expected: 'private'
	}
];

describe('cacheVisibility', () => {
	it.each(visibilityCases)(
		'reads $cache as a $expected destination',
		({ cache, expected }) => {
			expect(cacheVisibility(cache)).toBe(expected);
		}
	);
});

describe('defaultSigningPolicy', () => {
	it.each([
		{
			visibility: 'private',
			expected: {
				profile: 'tsa-only',
				uploadToGithub: false,
				grouping: 'individual'
			}
		},
		{
			visibility: 'public',
			expected: {
				profile: 'sigstore-default',
				uploadToGithub: true,
				grouping: 'run'
			}
		}
	] as const)(
		'returns the default signing policy for a $visibility destination',
		({ visibility, expected }) => {
			expect(defaultSigningPolicy(visibility)).toStrictEqual(expected);
		}
	);
});

describe('signingDisclosure', () => {
	it.each([
		{
			profile: 'tsa-only',
			uploadToGithub: false,
			expected: {
				instances: ['public-good'],
				services: [
					'oidc-and-fulcio',
					'certificate-transparency',
					'rfc-3161-tsa'
				],
				publications: ['bundle-files']
			}
		},
		{
			profile: 'tsa-only',
			uploadToGithub: true,
			expected: {
				instances: ['public-good'],
				services: [
					'oidc-and-fulcio',
					'certificate-transparency',
					'rfc-3161-tsa'
				],
				publications: ['github-attestation-store', 'bundle-files']
			}
		},
		{
			profile: 'rekor-and-tsa',
			uploadToGithub: false,
			expected: {
				instances: ['public-good'],
				services: [
					'oidc-and-fulcio',
					'certificate-transparency',
					'rfc-3161-tsa',
					'rekor'
				],
				publications: ['rekor', 'bundle-files']
			}
		},
		{
			profile: 'rekor-and-tsa',
			uploadToGithub: true,
			expected: {
				instances: ['public-good'],
				services: [
					'oidc-and-fulcio',
					'certificate-transparency',
					'rfc-3161-tsa',
					'rekor'
				],
				publications: ['rekor', 'github-attestation-store', 'bundle-files']
			}
		},
		{
			profile: 'sigstore-default',
			uploadToGithub: false,
			expected: {
				instances: ['public-good', 'github'],
				services: [
					'oidc-and-fulcio',
					'certificate-transparency',
					'rfc-3161-tsa',
					'rekor'
				],
				publications: ['rekor', 'bundle-files']
			}
		},
		{
			profile: 'sigstore-default',
			uploadToGithub: true,
			expected: {
				instances: ['public-good', 'github'],
				services: [
					'oidc-and-fulcio',
					'certificate-transparency',
					'rfc-3161-tsa',
					'rekor'
				],
				publications: ['rekor', 'github-attestation-store', 'bundle-files']
			}
		}
	] as const)(
		'discloses $profile with upload-to-github $uploadToGithub',
		({ profile, uploadToGithub, expected }) => {
			expect(
				signingDisclosure({ profile, uploadToGithub, grouping: 'run' }, 3)
			).toStrictEqual({ ...expected, grouping: 'run', subjectCount: 3 });
		}
	);

	it('renders one line for each contact and each publication', () => {
		const disclosure = signingDisclosure(
			{ profile: 'sigstore-default', uploadToGithub: true, grouping: 'run' },
			3
		);
		const lines = disclosureLines(disclosure);
		const listed = disclosure.services.length + disclosure.publications.length;

		expect({
			heading: lines[0],
			total: lines.length,
			listed: lines.filter((line) => line.startsWith('  ')).length
		}).toStrictEqual({
			heading:
				"The repository's visibility selects the Sigstore instance: the public-good instance for a public repository, the GitHub instance otherwise. The lines below cover both.",
			total: listed + 4,
			listed
		});
	});
});

describe('producedLines', () => {
	it.each([
		{
			profile: 'sigstore-default',
			evidence: {
				bundleCount: 2,
				tlogEntryCount: 0,
				timestampCount: 2,
				uploadedCount: 0
			},
			instance: 'github',
			lines: [
				'The bundles are in the trust domain of the GitHub Sigstore instance.',
				'The action signed 2 bundles that carry 0 Rekor entries and 2 RFC 3161 timestamps.',
				"The action recorded no bundle in the repository's attestation store."
			]
		},
		{
			profile: 'sigstore-default',
			evidence: {
				bundleCount: 1,
				tlogEntryCount: 1,
				timestampCount: 0,
				uploadedCount: 1
			},
			instance: 'public-good',
			lines: [
				'The bundle is in the trust domain of the public-good Sigstore instance.',
				'The action signed 1 bundle that carries 1 Rekor entry and 0 RFC 3161 timestamps.',
				"The action recorded 1 of 1 bundle in the repository's attestation store."
			]
		},
		{
			profile: 'sigstore-default',
			evidence: {
				bundleCount: 1,
				tlogEntryCount: 0,
				timestampCount: 0,
				uploadedCount: 0
			},
			instance: undefined,
			lines: [
				'The bundle carries no Rekor entry and no RFC 3161 timestamp.',
				'The action signed 1 bundle that carries 0 Rekor entries and 0 RFC 3161 timestamps.',
				"The action recorded no bundle in the repository's attestation store."
			]
		},
		{
			profile: 'tsa-only',
			evidence: {
				bundleCount: 1,
				tlogEntryCount: 0,
				timestampCount: 1,
				uploadedCount: 0
			},
			instance: 'public-good',
			lines: [
				'The bundle is in the trust domain of the public-good Sigstore instance.',
				'The action signed 1 bundle that carries 0 Rekor entries and 1 RFC 3161 timestamp.',
				"The action recorded no bundle in the repository's attestation store."
			]
		},
		{
			profile: 'rekor-and-tsa',
			evidence: {
				bundleCount: 3,
				tlogEntryCount: 3,
				timestampCount: 3,
				uploadedCount: 2
			},
			instance: 'public-good',
			lines: [
				'The bundles are in the trust domain of the public-good Sigstore instance.',
				'The action signed 3 bundles that carry 3 Rekor entries and 3 RFC 3161 timestamps.',
				"The action recorded 2 of 3 bundles in the repository's attestation store."
			]
		}
	] as const)(
		'reports the $instance trust domain for the $profile profile',
		({ profile, evidence, instance, lines }) => {
			expect({
				instance: producedInstance(profile, evidence),
				lines: producedLines(profile, evidence)
			}).toStrictEqual({ instance, lines });
		}
	);

	it('reports a run that signed nothing as one line', () => {
		expect(
			producedLines('tsa-only', {
				bundleCount: 0,
				tlogEntryCount: 0,
				timestampCount: 0,
				uploadedCount: 0
			})
		).toStrictEqual(['This run signed no statement.']);
	});
});

describe('githubStatementSigner', () => {
	const bundle = {
		mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
		verificationMaterial: {
			tlogEntries: [{ logIndex: '1' }],
			timestampVerificationData: {
				rfc3161Timestamps: [{ signedTimestamp: 'a' }]
			}
		}
	};

	it.each([{ uploadToGithub: false }, { uploadToGithub: true }] as const)(
		'delegates sigstore-default with upload-to-github $uploadToGithub',
		async ({ uploadToGithub }) => {
			mocks.attest.mockReset();
			mocks.attest.mockResolvedValue({
				bundle,
				certificate: 'certificate',
				attestationID: '42'
			});

			const result = await githubStatementSigner({
				subjects: [
					{
						name: 'abcdefghijklmnopqrstuvwxyz012345-app',
						sha256: '11'.repeat(32)
					}
				],
				githubToken: 'token',
				policy: {
					profile: 'sigstore-default',
					uploadToGithub,
					grouping: 'run'
				}
			})(statement);

			expect({ result, calls: mocks.attest.mock.calls }).toStrictEqual({
				result: {
					bundle: `${JSON.stringify(bundle)}\n`,
					evidence: { tlogEntryCount: 1, timestampCount: 1 },
					attestationId: '42'
				},
				calls: [
					[
						{
							subjects: [
								{
									name: 'abcdefghijklmnopqrstuvwxyz012345-app',
									digest: { sha256: '11'.repeat(32) }
								}
							],
							predicateType: statement.predicateType,
							predicate: statement.predicate,
							token: 'token',
							skipWrite: !uploadToGithub
						}
					]
				]
			});
		}
	);

	it('counts no timestamp when the bundle carries none', async () => {
		mocks.attest.mockReset();
		mocks.attest.mockResolvedValue({
			bundle: {
				mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
				verificationMaterial: { tlogEntries: [] }
			},
			certificate: 'certificate'
		});

		const result = await githubStatementSigner({
			subjects: [],
			githubToken: 'token',
			policy: {
				profile: 'sigstore-default',
				uploadToGithub: false,
				grouping: 'run'
			}
		})(statement);

		expect(result.evidence).toStrictEqual({
			tlogEntryCount: 0,
			timestampCount: 0
		});
	});

	it.each([
		{
			evidence: 'Rekor-only',
			verificationMaterial: {
				tlogEntries: [{ logIndex: '1' }],
				timestampVerificationData: {}
			},
			expected: { tlogEntryCount: 1, timestampCount: 0 }
		},
		{
			evidence: 'timestamp-only',
			verificationMaterial: {
				timestampVerificationData: {
					rfc3161Timestamps: [{ signedTimestamp: 'a' }]
				}
			},
			expected: { tlogEntryCount: 0, timestampCount: 1 }
		}
	] as const)(
		'counts fields omitted from a serialised $evidence bundle',
		async ({ verificationMaterial, expected }) => {
			const serialisedBundle = {
				mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json',
				verificationMaterial
			};

			mocks.attest.mockReset();
			mocks.attest.mockResolvedValue({
				bundle: serialisedBundle,
				certificate: 'certificate'
			});

			const result = await githubStatementSigner({
				subjects: [],
				githubToken: 'token',
				policy: {
					profile: 'sigstore-default',
					uploadToGithub: false,
					grouping: 'run'
				}
			})(statement);

			expect(result).toStrictEqual({
				bundle: `${JSON.stringify(serialisedBundle)}\n`,
				evidence: expected
			});
		}
	);
});

describe('slsaProvenanceStatement', () => {
	it('returns the generated predicate type and parameters as a statement', async () => {
		const parameters = { buildDefinition: { buildType: 'workflow' } };

		mocks.buildSLSAProvenancePredicate.mockResolvedValue({
			type: 'https://slsa.dev/provenance/v1',
			params: parameters
		});

		expect(await slsaProvenanceStatement()).toStrictEqual({
			predicateType: 'https://slsa.dev/provenance/v1',
			predicate: parameters
		});
	});
});
