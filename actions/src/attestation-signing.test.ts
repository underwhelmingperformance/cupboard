import type { AttestOptions, Predicate } from '@actions/attest';
import { createGithubReporter } from '@cupboard/reporter';
import { describe, expect, it, vi } from 'vitest';

import {
	type AttestationStatement,
	githubStatementSigner,
	isTransientSigningFailure,
	maxSigningAttempts,
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

/**
 * Stands in for a `@sigstore/sign` error: a code for the stage that failed,
 * with the underlying failure as its cause.
 */
class SigningFailure extends Error {
	constructor(
		public readonly code: SigningStageCode,
		public override readonly cause: unknown
	) {
		super('the signing attempt failed');
		this.name = 'SigningFailure';
	}
}

/**
 * Stands in for the error the Sigstore HTTP client throws for a non-2xx
 * response.
 */
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
		failure: 'fetching the log entry got no answer',
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
		failure: 'the timestamp authority gave no answer',
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

const signed: SignedAttestation = { bundle: '{"mediaType":"test"}\n' };

interface SigningRun {
	readonly signer: StatementSigner;
	/** The statement passed to the signer, recorded once per attempt. */
	readonly attempted: AttestationStatement[];
	/** The attempt number passed to each wait. */
	readonly delays: number[];
	readonly delay: (attempt: number) => Promise<void>;
}

/** A signer that fails with each listed error in turn, then succeeds. */
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

describe('githubStatementSigner', () => {
	it('sends each subject as a sha256 digest and returns the bundle as text', async () => {
		const bundle = {
			mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json'
		};

		mocks.attest.mockResolvedValue({
			bundle,
			certificate: 'certificate',
			attestationID: '42'
		});

		const signed = await githubStatementSigner({
			subjects: [
				{
					name: 'abcdefghijklmnopqrstuvwxyz012345-app',
					sha256: '11'.repeat(32)
				}
			],
			githubToken: 'token'
		})(statement);

		expect({ signed, calls: mocks.attest.mock.calls }).toStrictEqual({
			signed: { bundle: `${JSON.stringify(bundle)}\n`, attestationId: '42' },
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
						token: 'token'
					}
				]
			]
		});
	});
});

describe('slsaProvenanceStatement', () => {
	it('takes the type and the parameters of the generated predicate', async () => {
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
