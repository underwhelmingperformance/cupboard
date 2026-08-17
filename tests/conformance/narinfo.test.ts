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
 * Documents accepted by Nix, allowing exact field comparison between clients.
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
		name: `a narinfo without ${field}`,
		fixture: { fields: { [field]: undefined } }
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
	}
];

/**
 * Documents accepted by the pinned Nix but rejected by our stricter client.
 */
const stricterCases: readonly NarinfoCase[] = [
	{
		name: 'a compression algorithm Nix has no decompressor for',
		fixture: { fields: { Compression: 'banana' } }
	}
];

describeConformance('a narinfo read from a substituter', (oracle) => {
	// Directional: our client must reject every document that the oracle rejects.
	// It can also reject a document that the older, pinned Nix accepts because
	// the client targets the stricter validation in Nix master.
	it.for([...agreedCases, ...refusedCases, ...stricterCases])(
		'is no less strict than Nix for $name',
		async ({ fixture }, context) => {
			const outcome = await readNarinfo(oracle, fixture);

			if (outcome.oracle === 'rejected') {
				await context.annotate(outcome.oracleStderr.trim(), 'Nix rejection');
			}

			expect(looserThanOracle(outcome)).toStrictEqual([]);
		}
	);

	// Exact: compare every field after both clients accept the document.
	it.each(agreedCases)(
		'reports the same offer as Nix for $name',
		async ({ fixture }) => {
			const fields = comparedFields(await readNarinfo(oracle, fixture));

			expect(fields.client).toStrictEqual(fields.oracle);
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
