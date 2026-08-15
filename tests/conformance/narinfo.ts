import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
	type StoreDirectory,
	storeDirectorySchema,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import type { UnreachableSubstituter } from '../../packages/nix/src/nix-store.ts';
import {
	openSubstituters,
	SubstituterAnswerUnreadableError,
	SubstituterClient
} from '../../packages/nix/src/substituter.ts';
import { withTemporaryDirectory } from '../support/filesystem.ts';
import { isolatedEnvironment } from '../support/nix.ts';

import type { Oracle } from './oracle.ts';

/**
 * `nix path-info` reads a narinfo straight from a `file://` cache, which is
 * why the fixtures are served that way: Nix keeps a disk cache of the narinfos
 * it has read from a substituter, and a `file://` store bypasses it, so each
 * case observes the document it just wrote. Reading it needs the `nix-command`
 * feature, which the isolated configuration does not enable.
 *
 * `--json-format 1` pins the parsed response shape so a later format cannot
 * silently change field semantics.
 */
export function pathInfoArguments(
	directory: string,
	storePath: StorePathString
): readonly string[] {
	return [
		'--extra-experimental-features',
		'nix-command',
		'path-info',
		'--store',
		`file://${directory}`,
		'--json',
		'--json-format',
		'1',
		storePath
	];
}

/**
The store directory served by the fixture cache and configured on both sides.
*/
export const servedStoreDirectory: StoreDirectory =
	storeDirectorySchema.parse('/nix/store');

/**
The path every fixture describes.
*/
export const fixtureStorePath: StorePathString = storePathSchema.parse(
	'/nix/store/00000000000000000000000000000000-conformance-1.0'
);

/**
The file a cache serves the fixture path's narinfo as.
*/
export const fixtureNarinfoFile = '00000000000000000000000000000000.narinfo';

// Nix writes a sha256 digest in its own base32 in a narinfo, and reports it
// SRI-encoded in `path-info`. These two are the digests of the empty string
// and `abc`, giving the fixtures known, reproducible hash values.
const narHashBase32 = '0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73';
const fileHashBase32 = '0nx24zsppsazlbvgwqkirpmf1gc6as2slq83sf5y78qxgd9hvf1b';

const fixtureSignature =
	'cache.example.org-1:c2lnbmF0dXJlLWJ5dGVzLWhlcmUtZm9yLXRlc3Rpbmct' +
	'cHVycG9zZXMtb25seS1wYWRkaW5nLXh4eHh4eHh4eHh4eHh4eHg=';

/**
 * A valid narinfo used as the base for every fixture. Fields follow cache
 * output order, and each fixture specifies only its changes.
 */
const wellFormedFields: readonly (readonly [string, string])[] = [
	['StorePath', fixtureStorePath],
	['URL', 'nar/example.nar.xz'],
	['Compression', 'xz'],
	['FileHash', `sha256:${fileHashBase32}`],
	['FileSize', '1234'],
	['NarHash', `sha256:${narHashBase32}`],
	['NarSize', '5678'],
	['References', '11111111111111111111111111111111-dep-a'],
	['Deriver', '33333333333333333333333333333333-conformance-1.0.drv'],
	['Sig', fixtureSignature]
];

/**
Changes applied to the valid narinfo for one test case.
*/
export interface NarinfoFixture {
	/**
	 * Values replacing the well-formed document's, keyed by field name.
	 * `undefined` drops the field.
	 */
	readonly fields?: Readonly<Record<string, string | undefined>>;
	/**
	Whole lines added after the document, for a field written twice.
	*/
	readonly extraLines?: readonly string[];
	/**
	Whether the cache serves a document for the path at all.
	*/
	readonly served?: boolean;
	/**
	Whether the document ends with a newline, which Nix requires.
	*/
	readonly endsWithNewline?: boolean;
}

const wellFormedValues = new Map(wellFormedFields);

// A field the well-formed document does not carry is written after it, so a
// fixture can state one Nix reads only when it is there.
export function narinfoDocument(fixture: NarinfoFixture): string {
	const changed = fixture.fields ?? {};
	const names = [
		...wellFormedValues.keys(),
		...Object.keys(changed).filter((name) => !wellFormedValues.has(name))
	];
	const lines = names.flatMap((name) => {
		const value = Object.hasOwn(changed, name)
			? changed[name]
			: wellFormedValues.get(name);

		return value === undefined ? [] : [`${name}: ${value}`];
	});

	const document = [...lines, ...(fixture.extraLines ?? [])].join('\n');

	return fixture.endsWithNewline === false ? document : `${document}\n`;
}

/**
What one side made of a narinfo.
*/
export type NarinfoVerdict = 'accepted' | 'absent' | 'rejected';

/**
The fields both sides state for a path they accepted.
*/
export interface OfferFields {
	readonly narHash: string;
	readonly narSize: number;
	readonly downloadSize: number;
	readonly references: readonly string[];
	readonly deriver: string | undefined;
	readonly signatures: readonly string[];
}

/**
What both sides made of one narinfo.
*/
export interface NarinfoOutcome {
	readonly oracle: NarinfoVerdict;
	readonly client: NarinfoVerdict;
	/**
	Why the oracle refused it, for a case that reports the refusal.
	*/
	readonly oracleStderr: string;
	/**
	Both sides' fields, present when both accepted the document.
	*/
	readonly fields: { oracle: OfferFields; client: OfferFields } | undefined;
	/**
	What our client threw, for a document it refused.
	*/
	readonly clientError: unknown;
}

// When `FileSize` is absent, Nix omits the download-size field while our client
// reports zero. Normalise the two representations before comparison.
const pathInfoEntrySchema = z.object({
	narHash: z.string(),
	narSize: z.number(),
	downloadSize: z.number().optional(),
	references: z.array(z.string()),
	deriver: z.string().nullable(),
	signatures: z.array(z.string())
});

const pathInfoSchema = z.record(
	z.string(),
	pathInfoEntrySchema.nullable().optional()
);

export class UnparsablePathInfoError extends Error {
	constructor(
		public readonly output: string,
		options: { cause: unknown }
	) {
		super('nix path-info did not print JSON', options);
		this.name = 'UnparsablePathInfoError';
	}
}

export class InvalidPathInfoError extends Error {
	constructor(public readonly issues: readonly z.core.$ZodIssue[]) {
		super('nix path-info did not print the entry shape the suite reads');
		this.name = 'InvalidPathInfoError';
	}
}

/**
 * Parses the `nix path-info` result for the path. Nix prints a null entry and
 * exits zero when no substituter has the path, so absence is a normal result.
 */
export function oracleOffer(
	output: string,
	storePath: StorePathString
): OfferFields | undefined {
	let parsed: unknown;

	try {
		parsed = JSON.parse(output);
	} catch (error) {
		throw new UnparsablePathInfoError(output, { cause: error });
	}

	const result = pathInfoSchema.safeParse(parsed);

	if (!result.success) {
		throw new InvalidPathInfoError(result.error.issues);
	}

	const entry = result.data[storePath];

	if (entry === undefined || entry === null) {
		return;
	}

	return {
		narHash: entry.narHash,
		narSize: entry.narSize,
		downloadSize: entry.downloadSize ?? 0,
		references: sorted(entry.references),
		deriver: entry.deriver ?? undefined,
		signatures: sorted(entry.signatures)
	};
}

function compareStrings(left: string, right: string): number {
	if (left === right) {
		return 0;
	}

	return left < right ? -1 : 1;
}

// Nix keeps both of these as sets and prints them sorted, so both sides are
// sorted before they are compared and it is the members that are compared.
function sorted(values: readonly string[]): readonly string[] {
	return values.toSorted(compareStrings);
}

/**
Our client's result for the fixture cache and path.
*/
export interface ClientAnswer {
	/**
	What the cache offered for the path, in the oracle's shapes.
	*/
	readonly offer: OfferFields | undefined;
	/**
	The configured caches the client could not query.
	*/
	readonly unreachable: readonly UnreachableSubstituter[];
}

/**
 * Opens the directory as the client's only substituter and queries the fixture
 * path using the store URI parameters configured for both sides.
 */
export async function askClient(
	directory: string,
	parameters = ''
): Promise<ClientAnswer> {
	const { substituters, unreachable } = await openSubstituters(
		[`file://${directory}${parameters}`],
		{ storeDirectory: servedStoreDirectory }
	);
	const client = new SubstituterClient(substituters, {
		storeDirectory: servedStoreDirectory,
		substitute: true,
		// A malformed document must remain an error. With fallback enabled,
		// continuing past the error would incorrectly report an absence.
		fallback: false
	});
	const offers = await client.querySubstitutablePathInfos([fixtureStorePath]);
	const [offer] = offers;

	if (offer === undefined) {
		return { offer: undefined, unreachable };
	}

	return {
		offer: {
			// Nix reports a NAR hash SRI-encoded, which our own hash renders from
			// the digest it holds.
			narHash: `sha256-${offer.narHash.digestBase64()}`,
			narSize: offer.narSize,
			downloadSize: offer.downloadSize,
			references: sorted(offer.references),
			deriver: offer.deriver,
			signatures: sorted(offer.signatures)
		},
		unreachable
	};
}

interface ClientOutcome {
	readonly verdict: NarinfoVerdict;
	readonly offer: OfferFields | undefined;
	readonly error: unknown;
}

async function readAsClient(directory: string): Promise<ClientOutcome> {
	try {
		const { offer } = await askClient(directory);

		return {
			verdict: offer === undefined ? 'absent' : 'accepted',
			offer,
			error: undefined
		};
	} catch (error) {
		if (error instanceof SubstituterAnswerUnreadableError) {
			return { verdict: 'rejected', offer: undefined, error };
		}

		throw error;
	}
}

/**
Serves one narinfo from a `file://` cache and queries it through both clients.
*/
export async function readNarinfo(
	oracle: Oracle,
	fixture: NarinfoFixture
): Promise<NarinfoOutcome> {
	return withTemporaryDirectory(
		'cupboard-conformance-narinfo-',
		async (home) => {
			const environment = await isolatedEnvironment(home);
			const directory = path.join(home, 'cache');

			await mkdir(directory, { recursive: true });
			await writeFile(
				path.join(directory, 'nix-cache-info'),
				`StoreDir: ${servedStoreDirectory}\nWantMassQuery: 1\nPriority: 30\n`
			);

			if (fixture.served !== false) {
				await writeFile(
					path.join(directory, fixtureNarinfoFile),
					narinfoDocument(fixture)
				);
			}

			const shown = await oracle.run(
				pathInfoArguments(directory, fixtureStorePath),
				{ env: environment }
			);
			const entry =
				shown.status === 0
					? oracleOffer(shown.stdout, fixtureStorePath)
					: undefined;
			const client = await readAsClient(directory);
			const oracleVerdict = oracleVerdictOf(shown.status, entry);

			return {
				oracle: oracleVerdict,
				client: client.verdict,
				oracleStderr: shown.stderr,
				clientError: client.error,
				fields:
					entry === undefined || client.offer === undefined
						? undefined
						: { oracle: entry, client: client.offer }
			};
		}
	);
}

function oracleVerdictOf(
	status: number | null,
	entry: OfferFields | undefined
): NarinfoVerdict {
	if (status !== 0) {
		return 'rejected';
	}

	return entry === undefined ? 'absent' : 'accepted';
}

/**
 * Reports whether our client accepts a document rejected by the oracle. Our
 * client targets the stricter behaviour of Nix master, so rejecting an extra
 * document is allowed. Accepting a document rejected by the oracle is a
 * conformance failure because Nix would decline to fetch that path.
 */
export function looserThanOracle(outcome: NarinfoOutcome): readonly string[] {
	return outcome.oracle === 'rejected' && outcome.client !== 'rejected'
		? [`our client answered ${outcome.client} where nix refused the document`]
		: [];
}

export class NarinfoNotComparedError extends Error {
	constructor(public readonly outcome: NarinfoOutcome) {
		super('only one side read fields out of the document');
		this.name = 'NarinfoNotComparedError';
	}
}

/**
Both sides' fields, for a document they both accepted.
*/
export function comparedFields(outcome: NarinfoOutcome): {
	oracle: OfferFields;
	client: OfferFields;
} {
	if (outcome.fields === undefined) {
		throw new NarinfoNotComparedError(outcome);
	}

	return outcome.fields;
}
