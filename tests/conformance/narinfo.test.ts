import { expect, it } from 'vitest';

import {
	comparedFields,
	looserThanOracle,
	type NarinfoFixture,
	parsedFields,
	parserAgainstOracle,
	readNarinfo
} from './narinfo.ts';
import { describeConformance } from './oracle.ts';

interface NarinfoCase {
	readonly name: string;
	readonly fixture: NarinfoFixture;
}

const contentAddress =
	'fixed:r:sha256:0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73';
const reference = '11111111111111111111111111111111-dep-a';
const deriver = '33333333333333333333333333333333-conformance-1.0.drv';
const signature =
	'cache.example.org-1:c2lnbmF0dXJlLWJ5dGVzLWhlcmUtZm9yLXRlc3Rpbmct' +
	'cHVycG9zZXMtb25seS1wYWRkaW5nLXh4eHh4eHh4eHh4eHh4eHg=';
const secondSignature = signature.replace('example.org-1', 'example.org-2');

// Nix reads the references into a set, so each of these documents has the
// references `dep-a` and `dep-b`.
const repeatedReferences: NarinfoCase = {
	name: 'a reference listed twice',
	fixture: {
		fields: {
			References:
				'11111111111111111111111111111111-dep-a 11111111111111111111111111111111-dep-a'
		}
	}
};
const reorderedReferences: NarinfoCase = {
	name: 'references in another order, one of them twice',
	fixture: {
		fields: {
			References:
				'22222222222222222222222222222222-dep-b 11111111111111111111111111111111-dep-a 22222222222222222222222222222222-dep-b'
		}
	}
};

// Nix compares the key name and the decoded signature, so a signature without
// the base64 padding is the same signature as the padded one.
const unpaddedSignature: NarinfoCase = {
	name: 'a signature listed twice, once without padding',
	fixture: { extraLines: [`Sig: ${signature.replace(/=+$/u, '')}`] }
};

/**
Documents accepted by Nix, allowing exact field comparison between clients.
*/
const agreedCases: readonly NarinfoCase[] = [
	{ name: 'a well-formed narinfo', fixture: {} },
	{
		// The literal a cache serves for a path whose deriver it does not know.
		name: 'a deriver named as unknown',
		fixture: { fields: { Deriver: 'unknown-deriver' } }
	},
	{
		name: 'an unknown deriver after a real one',
		fixture: { extraLines: ['Deriver: unknown-deriver'] }
	},
	{
		name: 'a signature listed twice',
		fixture: { extraLines: [`Sig: ${signature}`] }
	},
	unpaddedSignature,
	repeatedReferences,
	reorderedReferences,
	{
		name: 'a field that this client does not know',
		fixture: { extraLines: ['X-Foo: 1'] }
	},
	{
		name: 'an empty compression',
		fixture: { fields: { Compression: '' } }
	},
	{
		name: 'a content address',
		fixture: {
			fields: {
				CA: 'fixed:sha256:0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73'
			}
		}
	},
	...[
		'Compression',
		'FileHash',
		'FileSize',
		'References',
		'Deriver',
		'Sig'
	].map((field) => ({
		name: `a narinfo without ${field}`,
		fixture: { fields: { [field]: undefined } }
	}))
];

/**
Documents in which a line-based reader finds a field that Nix does not read,
or a different value for a field. Nix accepts all of them, so the readers can
be compared field by field. `parseNarInfo` may refuse each one or read it as
Nix does. The unit tests in `narinfo.test.ts` check that it refuses them.
*/
const hiddenFieldCases: readonly NarinfoCase[] = [
	{
		name: 'a blank line before a content address',
		fixture: { extraLines: ['', `CA: ${contentAddress}`] }
	},
	{
		name: 'a whitespace-only line before a content address',
		fixture: { extraLines: [' '.repeat(3), `CA: ${contentAddress}`] }
	},
	{
		name: 'a field without a value before a content address',
		fixture: { extraLines: ['Junk:', `CA: ${contentAddress}`] }
	},
	{
		name: 'a field without a value before references',
		fixture: {
			fields: { References: undefined },
			extraLines: ['Junk:', `References: ${reference}`]
		}
	},
	{
		name: 'a field without a value before a deriver',
		fixture: {
			fields: { Deriver: undefined },
			extraLines: ['Junk:', `Deriver: ${deriver}`]
		}
	},
	{
		name: 'a field without a value before a signature',
		fixture: {
			fields: { Sig: undefined },
			extraLines: ['Junk:', `Sig: ${signature}`]
		}
	},
	{
		name: 'a NarSize without a space after the colon',
		fixture: { fields: { NarSize: undefined }, extraLines: ['NarSize:15678'] }
	},
	{
		name: 'a content address without a space after the colon',
		fixture: { extraLines: [`CA:X${contentAddress}`] }
	},
	{
		name: 'a URL without a space after the colon',
		fixture: {
			fields: { URL: undefined },
			extraLines: ['URL:Xnar/example.nar.zst']
		}
	}
];

/**
Documents that Nix rejects and that `parseNarInfo` must refuse, but which the
substituter client reports as absent instead of rejected. It reads each line
ending as part of the value, so the `StorePath` differs from the requested
path.
*/
const parserRefusedCases: readonly NarinfoCase[] = [
	{
		name: 'carriage return line endings',
		fixture: { lineEnding: '\r\n' }
	}
];

/**
Documents that `parseNarInfo` must read to the same fields as Nix, so a
refusal does not satisfy the comparison with the oracle by itself.
*/
const parsedCases: readonly NarinfoCase[] = [
	{ name: 'a well-formed narinfo', fixture: {} },
	{
		name: 'a content address and a second signature',
		fixture: {
			extraLines: [`CA: ${contentAddress}`, `Sig: ${secondSignature}`]
		}
	},
	{
		name: 'a deriver named as unknown',
		fixture: { fields: { Deriver: 'unknown-deriver' } }
	},
	{
		name: 'an empty content address',
		fixture: { fields: { CA: '' } }
	},
	{
		name: 'an unknown field with a value',
		fixture: { extraLines: ['Junk: value'] }
	},
	{
		// Nix keeps signatures in a set, so a repeated line gives one signature.
		name: 'a signature listed twice',
		fixture: { extraLines: [`Sig: ${signature}`] }
	},
	unpaddedSignature,
	repeatedReferences,
	reorderedReferences,
	...['X-Foo', 'Unknown2', 'lowercase', 'with space'].map((field) => ({
		name: `an unknown field named ${JSON.stringify(field)}`,
		fixture: { extraLines: [`${field}: 1`] }
	}))
];

/**
Documents that both Nix and our client must reject.
*/
const refusedCases: readonly NarinfoCase[] = [
	...['StorePath', 'URL', 'NarHash', 'NarSize'].map((field) => ({
		name: `a narinfo without ${field}`,
		fixture: { fields: { [field]: undefined } }
	})),
	{
		name: 'a malformed signature',
		fixture: { fields: { Sig: 'not-a-signature' } }
	},
	{
		name: 'a malformed content address',
		fixture: { fields: { CA: 'not a valid content address' } }
	},
	{
		name: 'a content address with an unsupported hash algorithm',
		fixture: { fields: { CA: `fixed:md4:${'a'.repeat(32)}` } }
	},
	{
		// Six bits do not form a complete byte, so the signature material is invalid.
		name: 'a signature with incomplete encoded data',
		fixture: { fields: { Sig: 'cache.example.org-1:A' } }
	},
	{
		name: 'a NAR hash digesting outside the base32 alphabet',
		fixture: { fields: { NarHash: `sha256:eouteoute${'a'.repeat(43)}` } }
	},
	{
		// A base16-encoded SHA-256 digest has 64 characters, all from the base16
		// alphabet. This value has the expected length but includes `z`.
		name: 'a file hash digesting outside the base16 alphabet',
		fixture: { fields: { FileHash: `sha256:${'z'.repeat(64)}` } }
	},
	{
		name: 'a content address written twice',
		fixture: {
			fields: {
				CA: 'fixed:sha256:0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73'
			},
			extraLines: [
				'CA: fixed:sha256:0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73'
			]
		}
	},
	{
		name: 'references written twice',
		fixture: {
			extraLines: ['References: 22222222222222222222222222222222-dep-b']
		}
	},
	{
		name: 'a last line ending without a newline',
		fixture: { endsWithNewline: false }
	},
	{
		name: 'a byte order mark before the first field',
		fixture: { prefix: '\u{FEFF}' }
	},
	{
		name: 'trailing whitespace after a content address',
		fixture: { fields: { CA: `${contentAddress} ` } }
	},
	{
		name: 'a NarSize of zero',
		fixture: { fields: { NarSize: '0' } }
	},
	{
		name: 'an empty URL',
		fixture: { fields: { URL: '' } }
	},
	{
		name: 'references separated by a tab',
		fixture: { fields: { References: `${reference}\t${reference}x` } }
	},
	...['nope', ''].map((value) => ({
		name: `a deriver of ${JSON.stringify(value)}`,
		fixture: { fields: { Deriver: value } }
	}))
];

/**
Documents accepted by the pinned Nix but rejected by our stricter client.
*/
const stricterCases: readonly NarinfoCase[] = [
	{
		// Nix reads the last NarHash line, so it takes this SHA-512 hash. Our
		// client only compares SHA-256 NAR hashes and rejects the document.
		name: 'a SHA-512 NAR hash after a SHA-256 one',
		fixture: { extraLines: [`NarHash: sha512:${'0'.repeat(128)}`] }
	},
	{
		name: 'a compression algorithm Nix has no decompressor for',
		fixture: { fields: { Compression: 'banana' } }
	}
];

class ConflictingCasesError extends Error {
	constructor(public readonly caseName: string) {
		super('two different cases have the same name');
		this.name = 'ConflictingCasesError';
	}
}

/**
The cases of the lists, once each. A case that two lists share runs once.
*/
function distinctCases(
	...lists: readonly (readonly NarinfoCase[])[]
): readonly NarinfoCase[] {
	const byName = new Map<string, NarinfoCase>();

	for (const candidate of lists.flat()) {
		const existing = byName.get(candidate.name);

		if (
			existing !== undefined &&
			JSON.stringify(existing.fixture) !== JSON.stringify(candidate.fixture)
		) {
			throw new ConflictingCasesError(candidate.name);
		}

		byName.set(candidate.name, candidate);
	}

	return byName.values().toArray();
}

describeConformance('a narinfo read from a substituter', (oracle) => {
	// Directional: our client must reject every document that the oracle rejects.
	// It can also reject a document that the older, pinned Nix accepts because
	// the client targets the stricter validation in Nix master.
	it.for([
		...agreedCases,
		...hiddenFieldCases,
		...refusedCases,
		...stricterCases
	])('is no less strict than Nix for $name', async ({ fixture }, context) => {
		const outcome = await readNarinfo(oracle, fixture);

		if (outcome.oracle === 'rejected') {
			await context.annotate(outcome.oracleStderr.trim(), 'Nix rejection');
		}

		expect(looserThanOracle(outcome)).toStrictEqual([]);
	});

	// Exact: compare every field after both clients accept the document.
	it.each([...agreedCases, ...hiddenFieldCases])(
		'reports the same offer as Nix for $name',
		async ({ fixture }) => {
			const fields = comparedFields(await readNarinfo(oracle, fixture));

			expect(fields.client).toStrictEqual(fields.oracle);
		}
	);

	// `parseNarInfo` is stricter than Nix. For every document it either refuses
	// the document or reports the fields that `nix path-info` reports, and it
	// never accepts a document that Nix rejects.
	it.for(
		distinctCases(
			agreedCases,
			hiddenFieldCases,
			parsedCases,
			parserRefusedCases,
			refusedCases,
			stricterCases
		)
	)('reads only what Nix reads for $name', async ({ fixture }) => {
		const { parser, oracle: nix } = parserAgainstOracle(
			await readNarinfo(oracle, fixture)
		);

		expect(parser).toStrictEqual(nix);
	});

	it.for(parsedCases)(
		'reads the same fields as Nix for $name',
		async ({ fixture }) => {
			const { parser, oracle: nix } = parsedFields(
				await readNarinfo(oracle, fixture)
			);

			expect(parser).toStrictEqual(nix);
		}
	);

	// A missing narinfo is a normal absence for both clients, not a malformed
	// document error.
	it('reports an absent narinfo as an absence', async () => {
		const outcome = await readNarinfo(oracle, { served: false });

		expect({ oracle: outcome.oracle, client: outcome.client }).toStrictEqual({
			oracle: 'absent',
			client: 'absent'
		});
	});
});
