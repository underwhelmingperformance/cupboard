import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	decodeDsseStatement,
	DsseDecodeError,
	InTotoStatementError,
	parseInTotoStatement
} from './in-toto.ts';

function payload(value: unknown): Uint8Array {
	return new TextEncoder().encode(
		typeof value === 'string' ? value : JSON.stringify(value)
	);
}

const validStatement = {
	_type: 'https://in-toto.io/Statement/v1',
	subject: [{ name: 'cupboard.tar.gz', digest: { sha256: 'a'.repeat(64) } }],
	predicateType: 'https://slsa.dev/provenance/v1',
	predicate: { buildDefinition: {} }
};

describe('parseInTotoStatement', () => {
	it('decodes the predicate type, subject digests and predicate', () => {
		expect(parseInTotoStatement(payload(validStatement))).toStrictEqual({
			predicateType: 'https://slsa.dev/provenance/v1',
			subjectDigests: ['a'.repeat(64)],
			predicate: { buildDefinition: {} }
		});
	});

	it.each([
		['not JSON', payload('not json')],
		[
			'the wrong statement type',
			payload({ ...validStatement, _type: 'wrong' })
		],
		['no subjects', payload({ ...validStatement, subject: [] })],
		[
			'a non-hex subject digest',
			payload({ ...validStatement, subject: [{ digest: { sha256: 'nope' } }] })
		],
		[
			'a missing predicate type',
			payload({ ...validStatement, predicateType: undefined })
		]
	])('rejects %s', (_name, bytes) => {
		expect(() => parseInTotoStatement(bytes)).toThrow(InTotoStatementError);
	});
});

describe('decodeDsseStatement', () => {
	it.each([
		['bytes that are not JSON', payload('not a bundle')],
		['JSON that is not a Sigstore bundle', payload({})]
	])('rejects %s', (_name, bytes) => {
		expect(() => decodeDsseStatement(bytes, z.unknown())).toThrow(
			DsseDecodeError
		);
	});
});
