import { attest, buildSLSAProvenancePredicate } from '@actions/attest';
import type { Reporter } from '@cupboard/reporter';
import { backoffDelay } from '@cupboard/shared/retry';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import { AttestationSigningError } from './errors.ts';

/** An in-toto subject: a store path's base name and its NAR hash digest. */
export interface AttestationSubject {
	readonly name: string;
	readonly sha256: string;
}

/** One predicate this run signs over the shared set of subjects. */
export interface AttestationStatement {
	readonly predicateType: string;
	readonly predicate: object;
}

/** The outcome of signing one statement. */
export interface SignedAttestation {
	/** The Sigstore bundle, as the text of a `.sigstore.json` document. */
	readonly bundle: string;
	/** The GitHub attestation record's identifier, when the API stored one. */
	readonly attestationId?: string;
}

export type StatementSigner = (
	statement: AttestationStatement
) => Promise<SignedAttestation>;

/**
 * `@sigstore/sign` labels each stage of a signing attempt with its own code.
 * These four are calls to Fulcio or to a witness, and such a call can fail
 * because the service was briefly unreachable. The identity codes
 * (`IDENTITY_TOKEN_READ_ERROR`, `IDENTITY_TOKEN_PARSE_ERROR`) are deliberately
 * absent: a job whose OIDC token cannot be read or decoded does not acquire a
 * usable one by waiting.
 */
const serviceCallCodes = new Set([
	'CA_CREATE_SIGNING_CERTIFICATE_ERROR',
	'TLOG_CREATE_ENTRY_ERROR',
	'TLOG_FETCH_ENTRY_ERROR',
	'TSA_CREATE_TIMESTAMP_ERROR'
]);

/**
 * The statuses that mean the service could not answer this time, rather than
 * that it refused what was asked. Fulcio answers a certificate it will not
 * issue with a 4xx and Rekor answers an entry it will not accept the same way,
 * so a refusal outside this set is final and the step must not repeat it.
 */
const retryableSigningStatuses = new Set<number>([
	StatusCodes.REQUEST_TIMEOUT,
	StatusCodes.TOO_MANY_REQUESTS,
	StatusCodes.INTERNAL_SERVER_ERROR,
	StatusCodes.BAD_GATEWAY,
	StatusCodes.SERVICE_UNAVAILABLE,
	StatusCodes.GATEWAY_TIMEOUT
]);

const signingFailureSchema = z.object({ code: z.string(), cause: z.unknown() });

const httpFailureSchema = z.object({ statusCode: z.number() });

/**
 * Whether a signing failure is worth another attempt. A call to Fulcio or to a
 * witness that never received an answer, or that the service answered with a
 * retryable status, is transient. Everything else is final, including a failure
 * this action cannot classify.
 */
export function isTransientSigningFailure(error: unknown): boolean {
	const failure = signingFailureSchema.safeParse(error);

	if (!failure.success || !serviceCallCodes.has(failure.data.code)) {
		return false;
	}

	const http = httpFailureSchema.safeParse(failure.data.cause);

	// Without a status the call never reached the service or never got an
	// answer: a DNS fault, a refused connection or a request timeout.
	if (!http.success) {
		return true;
	}

	return retryableSigningStatuses.has(http.data.statusCode);
}

/** How many times one statement is signed before the step fails. */
export const maxSigningAttempts = 4;

export interface SigningDependencies {
	/** Waits before the next attempt. A test supplies its own to run promptly. */
	readonly delay?: (attempt: number) => Promise<void>;
}

/**
 * Signs one statement, repeating a transient Fulcio or witness failure with
 * bounded back-off. Every attempt signs from the beginning with a fresh key,
 * certificate and log entry, so an attempt never depends on what a failed one
 * left behind. When the attempts run out, or the failure is not transient, the
 * caller gets an {@link AttestationSigningError} and the step fails.
 */
export async function signStatement(
	statement: AttestationStatement,
	sign: StatementSigner,
	reporter: Reporter,
	dependencies: SigningDependencies = {}
): Promise<SignedAttestation> {
	const delay = dependencies.delay ?? backoffDelay;

	for (let attempt = 1; ; attempt += 1) {
		try {
			return await sign(statement);
		} catch (error) {
			if (attempt >= maxSigningAttempts || !isTransientSigningFailure(error)) {
				throw new AttestationSigningError(statement.predicateType, attempt, {
					cause: error
				});
			}

			reporter.warn(
				`Could not sign the ${statement.predicateType} attestation; starting attempt ${String(attempt + 1)} of ${String(maxSigningAttempts)}`
			);
			await delay(attempt);
		}
	}
}

export interface GithubSignerOptions {
	readonly subjects: readonly AttestationSubject[];
	readonly githubToken: string;
}

/**
 * Signs statements the way `actions/attest` does: the Sigstore instance follows
 * the repository's visibility, and each signed bundle is also written to the
 * repository's attestation store so `gh attestation verify` finds it.
 */
export function githubStatementSigner(
	options: GithubSignerOptions
): StatementSigner {
	const subjects = options.subjects.map((subject) => ({
		name: subject.name,
		digest: { sha256: subject.sha256 }
	}));

	return async (statement) => {
		const attestation = await attest({
			subjects,
			predicateType: statement.predicateType,
			predicate: statement.predicate,
			token: options.githubToken
		});

		return {
			bundle: `${JSON.stringify(attestation.bundle)}\n`,
			...(attestation.attestationID !== undefined && {
				attestationId: attestation.attestationID
			})
		};
	};
}

/**
 * The SLSA build provenance for this workflow run, built from the run's OIDC
 * claims. It is the predicate `actions/attest-build-provenance` signs.
 */
export async function slsaProvenanceStatement(): Promise<AttestationStatement> {
	const predicate = await buildSLSAProvenancePredicate();

	return { predicateType: predicate.type, predicate: predicate.params };
}
