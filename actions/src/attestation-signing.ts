import { attest, buildSLSAProvenancePredicate } from '@actions/attest';
import type { Reporter } from '@cupboard/reporter';
import { backoffDelay } from '@cupboard/shared/retry';
import type { InternalError } from '@sigstore/sign';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import { AttestationSigningError } from './errors.ts';

export interface AttestationSubject {
	readonly name: string;
	readonly sha256: string;
}

export interface AttestationStatement {
	readonly predicateType: string;
	readonly predicate: object;
}

export interface SignedAttestation {
	readonly bundle: string;
	readonly attestationId?: string;
}

export type StatementSigner = (
	statement: AttestationStatement
) => Promise<SignedAttestation>;

/**
 * `@sigstore/sign` does not export its stage-code union. Derive it from the
 * exported error class so this type stays aligned with the installed package.
 */
export type SigningStageCode = InternalError['code'];

/**
 * Retry only stages that call Fulcio or a witness. The identity codes
 * (`IDENTITY_TOKEN_READ_ERROR`, `IDENTITY_TOKEN_PARSE_ERROR`) are left out,
 * because an OIDC token the job cannot read or decode is no more readable a few
 * seconds later.
 */
const serviceCallCodes = [
	'CA_CREATE_SIGNING_CERTIFICATE_ERROR',
	'TLOG_CREATE_ENTRY_ERROR',
	'TLOG_FETCH_ENTRY_ERROR',
	'TSA_CREATE_TIMESTAMP_ERROR'
] as const satisfies readonly SigningStageCode[];

/**
 * Retry only statuses that can reflect a temporary service failure. Fulcio may
 * use another 4xx status to refuse a certificate, and Rekor may use one to
 * reject an entry. Repeating those requests would get the same refusal, so
 * every status outside this set fails the step at once.
 */
const retryableSigningStatuses = new Set<number>([
	StatusCodes.REQUEST_TIMEOUT,
	StatusCodes.TOO_MANY_REQUESTS,
	StatusCodes.INTERNAL_SERVER_ERROR,
	StatusCodes.BAD_GATEWAY,
	StatusCodes.SERVICE_UNAVAILABLE,
	StatusCodes.GATEWAY_TIMEOUT
]);

const signingFailureSchema = z.object({
	code: z.enum(serviceCallCodes),
	cause: z.unknown()
});

const httpFailureSchema = z.object({ statusCode: z.number() });

/**
 * Retries a recognised Fulcio or witness call when it received no response or
 * one of {@link retryableSigningStatuses}. Everything else is final, including
 * a failure with no recognised stage code.
 */
export function isTransientSigningFailure(error: unknown): boolean {
	const failure = signingFailureSchema.safeParse(error);

	if (!failure.success) {
		return false;
	}

	const http = httpFailureSchema.safeParse(failure.data.cause);

	// A cause without a status code means the request received no response: a
	// DNS failure, a refused connection or a timed-out socket.
	if (!http.success) {
		return true;
	}

	return retryableSigningStatuses.has(http.data.statusCode);
}

export const maxSigningAttempts = 4;

export interface SigningDependencies {
	readonly delay?: (attempt: number) => Promise<void>;
}

/**
 * Signs one statement, attempting again after a transient Fulcio or witness
 * failure and backing off between attempts. Each attempt signs from the
 * beginning and gets its own key, certificate and log entry, so a later attempt
 * never depends on the log entry a failed one created. When the failure is
 * final, or the attempts run out, the caller gets an
 * {@link AttestationSigningError} and the step fails.
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
 * Signs statements through `@actions/attest`, which chooses the Sigstore
 * instance from the repository's visibility and writes each signed bundle to
 * the repository's attestation store, so `gh attestation verify` finds it.
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
 * Uses the same OIDC-derived SLSA predicate as
 * `actions/attest-build-provenance`.
 */
export async function slsaProvenanceStatement(): Promise<AttestationStatement> {
	const predicate = await buildSLSAProvenancePredicate();

	return { predicateType: predicate.type, predicate: predicate.params };
}
