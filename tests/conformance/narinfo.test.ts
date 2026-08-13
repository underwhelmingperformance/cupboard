import { expect, it } from 'vitest';

import {
	comparedFields,
	looserThanOracle,
	type NarinfoFixture,
	readNarinfo
} from './narinfo.ts';
import { describeConformance } from './oracle.ts';

interface NarinfoCase {
	readonly name: string;
	readonly fixture: NarinfoFixture;
}

/**
 * Documents Nix reads without complaint, so both sides state what the path
 * offers and the fields can be compared.
 */
const agreedCases: readonly NarinfoCase[] = [
	{ name: 'a well-formed narinfo', fixture: {} },
	{
		// The literal a cache serves for a path whose deriver it does not know.
		name: 'a deriver named as unknown',
		fixture: { fields: { Deriver: 'unknown-deriver' } }
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
		name: `a narinfo carrying no ${field}`,
		fixture: { fields: { [field]: undefined } }
	}))
];

/** Documents Nix refuses, which our client has to refuse as well. */
const refusedCases: readonly NarinfoCase[] = [
	...['StorePath', 'URL', 'NarHash', 'NarSize'].map((field) => ({
		name: `a narinfo carrying no ${field}`,
		fixture: { fields: { [field]: undefined } }
	})),
	{
		name: 'a signature nothing can be decoded from',
		fixture: { fields: { Sig: 'not-a-signature' } }
	},
	{
		name: 'a content address in no readable form',
		fixture: { fields: { CA: 'not a valid content address' } }
	},
	{
		name: 'a content address naming an algorithm nix does not know',
		fixture: { fields: { CA: `fixed:md4:${'a'.repeat(32)}` } }
	},
	{
		// Six bits are no whole byte, so the line names a key and states
		// nothing signed under it.
		name: 'a signature whose material decodes to nothing',
		fixture: { fields: { Sig: 'cache.example.org-1:A' } }
	},
	{
		name: 'a NAR hash digesting outside the base32 alphabet',
		fixture: { fields: { NarHash: `sha256:eouteoute${'a'.repeat(43)}` } }
	},
	{
		// A 64-character digest is the length base16 writes, so a character
		// outside that alphabet is one no digest of that length carries.
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
	}
];

/**
 * Documents our client refuses and Nix takes. Refusing more than Nix does is
 * conformant, so these ride the same directional case as the rest.
 */
const stricterCases: readonly NarinfoCase[] = [
	{
		name: 'a compression algorithm Nix has no decompressor for',
		fixture: { fields: { Compression: 'banana' } }
	}
];

describeConformance('a narinfo read from a substituter', (oracle) => {
	// Directional: whatever the oracle refuses, our client has to refuse too.
	// Refusing a document the oracle takes is conformant, since our client
	// targets the strictness of Nix master and the pinned oracle is behind it.
	it.for([...agreedCases, ...refusedCases, ...stricterCases])(
		'is no looser than nix about $name',
		async ({ fixture }, context) => {
			const outcome = await readNarinfo(oracle, fixture);

			if (outcome.oracle === 'rejected') {
				await context.annotate(outcome.oracleStderr.trim(), 'nix refused it');
			}

			expect(looserThanOracle(outcome)).toStrictEqual([]);
		}
	);

	// Exact: for a document both sides took, every field the offer states has
	// to be the field nix states.
	it.each(agreedCases)(
		'states the same offer as nix for $name',
		async ({ fixture }) => {
			const fields = comparedFields(await readNarinfo(oracle, fixture));

			expect(fields.client).toStrictEqual(fields.oracle);
		}
	);

	// A path the cache holds no document for is an answer both sides give,
	// rather than a failure either reports. Every case above rests on the
	// difference between that and a refusal.
	it('reads a path the cache holds nothing for as an absence', async () => {
		const outcome = await readNarinfo(oracle, { served: false });

		expect({ oracle: outcome.oracle, client: outcome.client }).toStrictEqual({
			oracle: 'absent',
			client: 'absent'
		});
	});
});
