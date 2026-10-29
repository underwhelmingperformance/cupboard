import { describe, expect, it } from 'vitest';

import {
	redactKeyValues,
	redactOptionValues,
	type ScannedText
} from './credential-scanner.ts';

/**
A text that counts the characters that a scan reads.
*/
class CountingText implements ScannedText {
	reads = 0;

	constructor(private readonly text: string) {}

	get length(): number {
		return this.text.length;
	}

	codePointAt(index: number): number | undefined {
		this.reads += 1;
		return this.text.codePointAt(index);
	}

	slice(start: number, end?: number): string {
		return this.text.slice(start, end);
	}
}

/**
Specification patterns for the scans. They state the rules as regular
expressions with lookarounds and back-references, which recheck cannot
analyse, so production code uses the scans. They are not the patterns that
earlier releases used: those ended a quoted value only at a closing quotation
mark, matched fewer credential words in keys, and had no option rule.
*/
const keyValuePattern =
	/(?<![\w.-])(?=[\w.-]*?(?:pass(?:code|phrase|word)|secret|token|credential|private.?key|signature|authorization|cookie|api[-_]?key))(?=([\w.-]+))\1(["']?\s*[:=]\s*)("(?:\\[\s\S]?|[^"\\])*(?:"|$)|'(?:\\[\s\S]?|[^'\\])*(?:'|$)|(?:Basic|Bearer)\s+[^\s,;}]+|[^\s,;}]+)/giu;

const optionPattern =
	/(?<![\w.-])(?=-{1,2}[\w-]*?(?:pass(?:code|phrase|word)|secret|token|credential|private.?key|signature|authorization|cookie|api[-_]?key))(?=(-{1,2}[\w-]+))\1(\s+)("(?:\\[\s\S]?|[^"\\])*(?:"|$)|'(?:\\[\s\S]?|[^'\\])*(?:'|$)|\S+)/giu;

function quoted(value: string): string {
	const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : '';

	return `${quote}[redacted]${quote}`;
}

function redactKeyValuesWithPattern(text: string): string {
	return text.replaceAll(
		keyValuePattern,
		(_match, key: string, separator: string, value: string) =>
			`${key}${separator}${quoted(value)}`
	);
}

function redactOptionValuesWithPattern(text: string): string {
	return text.replaceAll(
		optionPattern,
		(_match, option: string, spaces: string, value: string) =>
			`${option}${spaces}${quoted(value)}`
	);
}

const pieces = [
	'password',
	'Password',
	'PASSWORD',
	'pa\u{17F}sword',
	'token',
	'secret',
	'api-key',
	'api_key',
	'apikey',
	'api_\u{212A}ey',
	'credential',
	'authorization',
	'cookie',
	'passphrase',
	'passcode',
	'private.key',
	'private-key',
	'private key',
	'signature',
	'=',
	':',
	' : ',
	'"',
	"'",
	'\\',
	' ',
	'  ',
	'\t',
	'\n',
	'\r\n',
	'\u{2028}',
	'\u{A0}',
	',',
	';',
	'}',
	'{',
	'.',
	'-',
	'--',
	'_',
	'Bearer ',
	'Basic ',
	'ba\u{17F}ic ',
	'bearer',
	'https://',
	'example.com/',
	'ghp_',
	'eyJ',
	'abc',
	'x',
	'1',
	'é',
	'😀',
	'\u{D83D}'
];

/**
Generates strings from `pieces` with a linear congruential generator, so every
run tests the same corpus.
*/
function generateCorpus(count: number): string[] {
	let seed = 12_345;
	const random = (limit: number): number => {
		seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
		return Math.floor((seed / 2_147_483_648) * limit);
	};

	return Array.from({ length: count }, () =>
		Array.from(
			{ length: 1 + random(30) },
			() => pieces[random(pieces.length)] ?? ''
		).join('')
	);
}

const corpus = generateCorpus(20_000);

const passes = [
	['key-value', redactKeyValues, redactKeyValuesWithPattern],
	['option', redactOptionValues, redactOptionValuesWithPattern]
] as const;

describe('credential scanner', () => {
	it.each(passes)(
		'redacts the same text as the %s specification pattern',
		(_pass, redact, redactWithPattern) => {
			const differences = corpus
				.map((text) => ({
					text,
					expected: redactWithPattern(text),
					actual: redact(text)
				}))
				.filter(({ expected, actual }) => expected !== actual);

			expect(differences).toStrictEqual([]);
		}
	);

	const shapes: readonly [string, string][] = [
		['a dotted name', 'a.'],
		['a repeated credential name', 'password'],
		['a repeated folded credential name', 'pa\u{17F}sword'],
		['a dotted credential name', 'a-password.'],
		['a repeated option', '--password'],
		['an escaped quoted value', String.raw`password="\a`],
		['credential names on separate lines', 'token: \n'],
		['an option followed by spaces', '--token          ']
	];

	it.each(
		shapes.flatMap(([shape, unit]) =>
			passes.map(([pass, redact]) => ({ shape, unit, pass, redact }))
		)
	)(
		'reads each character of $shape a bounded number of times in the $pass scan',
		({ unit, redact }) => {
			const readsPerCharacter = [1024, 65_536].map((length) => {
				const text = new CountingText(
					unit.repeat(Math.ceil(length / unit.length))
				);

				redact(text);

				return text.reads / text.length;
			});

			expect(Math.max(...readsPerCharacter)).toBeLessThanOrEqual(8);
		}
	);
});
