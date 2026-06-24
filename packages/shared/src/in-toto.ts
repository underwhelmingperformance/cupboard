import { bundleFromJSON, isBundleWithDsseEnvelope } from '@sigstore/bundle';
import { z } from 'zod';

const inTotoPayloadType = 'application/vnd.in-toto+json';
const inTotoStatementType = 'https://in-toto.io/Statement/v1';
const sha256HexPattern = /^[0-9a-f]{64}$/;

/**
 * The plain leaf schemas: a lowercase-hex sha256 subject digest and a string
 * predicate type. Consumers that brand these values pass their own schemas in
 * instead.
 */
export const defaultInTotoLeaves = {
	sha256: z.string().regex(sha256HexPattern),
	predicateType: z.string()
};

/**
 * The in-toto Statement schema for the given leaf schemas. The Statement
 * invariants, the `_type` literal and at least one subject, are fixed here; the
 * subject digest and predicate type vary per consumer. The predicate is left
 * unvalidated for the caller to interpret.
 */
export function inTotoStatementSchema<
	Sha256 extends z.ZodType<string>,
	PredicateType extends z.ZodType<string>
>(leaves: { readonly sha256: Sha256; readonly predicateType: PredicateType }) {
	const subjectSchema = z.object({
		digest: z.object({ sha256: leaves.sha256 })
	});

	return z.object({
		_type: z.literal(inTotoStatementType),
		subject: z.array(subjectSchema).min(1),
		predicateType: leaves.predicateType,
		predicate: z.unknown()
	});
}

interface InTotoStatement {
	readonly predicateType: string;
	readonly subjectDigests: readonly string[];
	readonly predicate: unknown;
}

type SigstoreBundle = ReturnType<typeof bundleFromJSON>;

/** An in-toto Statement payload that is malformed or fails its schema. */
export class InTotoStatementError extends Error {
	constructor(public readonly detail: string) {
		super(`in-toto statement ${detail}`);
		this.name = 'InTotoStatementError';
	}
}

/** A Sigstore bundle whose in-toto Statement could not be decoded. */
export class DsseDecodeError extends Error {
	constructor(
		public readonly detail: string,
		options?: { readonly cause?: unknown }
	) {
		super(`DSSE bundle ${detail}`, options);
		this.name = 'DsseDecodeError';
	}
}

const defaultStatementSchema = inTotoStatementSchema(defaultInTotoLeaves);

/**
 * Decode and validate the in-toto Statement carried in a DSSE payload, returning
 * its predicate type, the sha256 digest of each subject, and the raw predicate.
 * Throws {@link InTotoStatementError} when the payload is not a valid statement.
 */
export function parseInTotoStatement(payload: Uint8Array): InTotoStatement {
	let statement: z.infer<typeof defaultStatementSchema>;

	try {
		statement = defaultStatementSchema.parse(
			JSON.parse(new TextDecoder().decode(payload))
		);
	} catch (error) {
		throw new InTotoStatementError(
			error instanceof Error ? error.message : String(error)
		);
	}

	return {
		predicateType: statement.predicateType,
		subjectDigests: statement.subject.map((subject) => subject.digest.sha256),
		predicate: statement.predicate
	};
}

/**
 * Decode the in-toto Statement carried in a Sigstore DSSE bundle, validating its
 * payload with the given statement schema. Returns the parsed statement together
 * with the bundle so callers can go on to verify it. Throws
 * {@link DsseDecodeError} when the bytes are not a DSSE bundle carrying a valid
 * in-toto statement.
 */
export function decodeDsseStatement<Statement>(
	bytes: Uint8Array,
	statementSchema: z.ZodType<Statement>
): { readonly bundle: SigstoreBundle; readonly statement: Statement } {
	let bundle: SigstoreBundle;

	try {
		bundle = bundleFromJSON(JSON.parse(new TextDecoder().decode(bytes)));
	} catch (error) {
		throw new DsseDecodeError(
			`could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error }
		);
	}

	if (!isBundleWithDsseEnvelope(bundle)) {
		throw new DsseDecodeError('is not a Sigstore DSSE bundle');
	}

	const envelope = bundle.content.dsseEnvelope;

	if (envelope.payloadType !== inTotoPayloadType) {
		throw new DsseDecodeError('DSSE payload is not in-toto');
	}

	try {
		const statement = statementSchema.parse(
			JSON.parse(new TextDecoder().decode(envelope.payload))
		);

		return { bundle, statement };
	} catch (error) {
		throw new DsseDecodeError(
			error instanceof Error ? error.message : String(error),
			{ cause: error }
		);
	}
}
