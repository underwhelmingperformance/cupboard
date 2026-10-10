import type { AttestOptions, Predicate } from '@actions/attest';
import { maxAttestationBundleBytes } from '@cupboard/protocol/attestations';
import { createGithubReporter } from '@cupboard/reporter';
import { describe, expect, it, vi } from 'vitest';

import {
	type AttestationStatement,
	defaultSigningPolicy,
	githubStatementSigner,
	isTransientSigningFailure,
	maxSigningAttempts,
	producedInstance,
	type SignedAttestation,
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

describe('defaultSigningPolicy', () => {
	it.each([
		{
			access: 'private',
			expected: {
				profile: 'tsa-only',
				uploadToGithub: false,
				grouping: 'individual'
			}
		},
		{
			access: 'public',
			expected: {
				profile: 'sigstore-default',
				uploadToGithub: true,
				grouping: 'run'
			}
		}
	] as const)(
		'returns the default signing policy for a $access destination',
		({ access, expected }) => {
			expect(defaultSigningPolicy(access)).toStrictEqual(expected);
		}
	);
});

describe('producedInstance', () => {
	it.each([
		{
			profile: 'sigstore-default',
			evidence: { tlogEntryCount: 0, timestampCount: 1 },
			instance: 'github'
		},
		{
			profile: 'sigstore-default',
			evidence: { tlogEntryCount: 1, timestampCount: 0 },
			instance: 'public-good'
		},
		{
			profile: 'sigstore-default',
			evidence: { tlogEntryCount: 0, timestampCount: 0 },
			instance: undefined
		},
		{
			profile: 'tsa-only',
			evidence: { tlogEntryCount: 0, timestampCount: 1 },
			instance: 'public-good'
		},
		{
			profile: 'rekor-and-tsa',
			evidence: { tlogEntryCount: 1, timestampCount: 1 },
			instance: 'public-good'
		}
	] as const)(
		'reports the $instance trust domain for the $profile profile',
		({ profile, evidence, instance }) => {
			expect(producedInstance(profile, evidence)).toBe(instance);
		}
	);
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
			const writeAttestation = vi.fn().mockResolvedValue('42');
			mocks.attest.mockResolvedValue({
				bundle,
				certificate: 'certificate'
			});

			const result = await githubStatementSigner(
				{
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
				},
				{
					writeAttestation,
					environment: { GITHUB_REPOSITORY: 'acme/app' }
				}
			)(statement);

			expect({
				result,
				calls: mocks.attest.mock.calls,
				writes: writeAttestation.mock.calls
			}).toStrictEqual({
				result: {
					bundle: `${JSON.stringify(bundle)}\n`,
					evidence: { tlogEntryCount: 1, timestampCount: 1 },
					...(uploadToGithub && { attestationId: '42' })
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
							skipWrite: true
						}
					]
				],
				writes: uploadToGithub
					? [
							[
								{
									bundle: `${JSON.stringify(bundle)}\n`,
									githubToken: 'token',
									environment: { GITHUB_REPOSITORY: 'acme/app' }
								}
							]
						]
					: []
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

	it('does not upload a bundle that the destination cache would reject', async () => {
		const writeAttestation = vi.fn().mockResolvedValue('42');
		const oversizedBundle = {
			verificationMaterial: {
				tlogEntries: [],
				certificate: 'a'.repeat(maxAttestationBundleBytes)
			}
		};
		mocks.attest.mockReset();
		mocks.attest.mockResolvedValue({ bundle: oversizedBundle });

		const result = await githubStatementSigner(
			{
				subjects: [],
				githubToken: 'token',
				policy: {
					profile: 'sigstore-default',
					uploadToGithub: true,
					grouping: 'run'
				}
			},
			{ writeAttestation }
		)(statement);

		expect({ result, writes: writeAttestation.mock.calls }).toStrictEqual({
			result: {
				bundle: `${JSON.stringify(oversizedBundle)}\n`,
				evidence: { tlogEntryCount: 0, timestampCount: 0 }
			},
			writes: []
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
