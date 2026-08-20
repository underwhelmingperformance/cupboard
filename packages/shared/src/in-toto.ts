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
 * Creates an in-toto Statement schema from the supplied leaf schemas. This
 * function requires the Statement `_type` and at least one subject. The caller
 * supplies the schemas for subject digests and predicate types. The predicate
 * remains unvalidated for the caller to interpret.
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

/**
An in-toto Statement payload that is malformed or fails its schema.
*/
export class InTotoStatementError extends Error {
	constructor(public readonly detail: string) {
		super(`in-toto statement ${detail}`);
		this.name = 'InTotoStatementError';
	}
}

/**
A Sigstore bundle whose in-toto Statement could not be decoded.
*/
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
 * Decodes and validates an in-toto Statement from a DSSE payload. Returns the
 * predicate type, each subject's SHA-256 digest, and the unvalidated predicate.
 * Throws {@link InTotoStatementError} if the payload is not a valid Statement.
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
 * Decodes a Sigstore DSSE bundle and validates its in-toto Statement with
 * `statementSchema`. Returns both parsed values so the caller can verify the
 * bundle. Throws {@link DsseDecodeError} if the bytes do not contain a valid
 * DSSE bundle and Statement.
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
