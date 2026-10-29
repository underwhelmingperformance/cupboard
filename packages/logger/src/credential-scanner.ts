/**
The text that a scan reads. A string has this shape, and a test can pass an
object that counts the characters that the scan reads.
*/
export interface ScannedText {
	readonly length: number;
	codePointAt(index: number): number | undefined;
	slice(start: number, end?: number): string;
}

const redacted = '[redacted]';

/**
The value that `characterAt` returns past the end of the text. It matches no
character class.
*/
const noCharacter = -1;

const code = {
	tab: 0x09,
	lineFeed: 0x0a,
	carriageReturn: 0x0d,
	space: 0x20,
	quotationMark: 0x22,
	apostrophe: 0x27,
	comma: 0x2c,
	hyphen: 0x2d,
	fullStop: 0x2e,
	digitZero: 0x30,
	digitNine: 0x39,
	colon: 0x3a,
	semicolon: 0x3b,
	equalsSign: 0x3d,
	capitalA: 0x41,
	capitalZ: 0x5a,
	backslash: 0x5c,
	lowLine: 0x5f,
	smallA: 0x61,
	smallK: 0x6b,
	smallS: 0x73,
	smallZ: 0x7a,
	rightCurlyBracket: 0x7d,
	noBreakSpace: 0xa0,
	longS: 0x1_7f,
	ogham: 0x16_80,
	enQuad: 0x20_00,
	hairSpace: 0x20_0a,
	lineSeparator: 0x20_28,
	paragraphSeparator: 0x20_29,
	narrowNoBreakSpace: 0x20_2f,
	mediumMathematicalSpace: 0x20_5f,
	kelvinSign: 0x21_2a,
	ideographicSpace: 0x30_00,
	byteOrderMark: 0xfe_ff
} as const;

/**
Folds a character the way a case-insensitive Unicode regular expression
compares it with an ASCII letter. Simple case folding maps U+017F LATIN SMALL
LETTER LONG S to `s` and U+212A KELVIN SIGN to `k`.
*/
function fold(character: number): number {
	if (character >= code.capitalA && character <= code.capitalZ) {
		return character + (code.smallA - code.capitalA);
	}

	if (character === code.longS) {
		return code.smallS;
	}

	if (character === code.kelvinSign) {
		return code.smallK;
	}

	return character;
}

/**
`\w` in a case-insensitive Unicode regular expression, which also matches the
two characters that fold to ASCII letters.
*/
function isWordCharacter(character: number): boolean {
	const folded = fold(character);

	return (
		(folded >= code.smallA && folded <= code.smallZ) ||
		(character >= code.digitZero && character <= code.digitNine) ||
		character === code.lowLine
	);
}

function isKeyCharacter(character: number): boolean {
	return (
		isWordCharacter(character) ||
		character === code.fullStop ||
		character === code.hyphen
	);
}

function isOptionCharacter(character: number): boolean {
	return isWordCharacter(character) || character === code.hyphen;
}

const lineTerminators: ReadonlySet<number> = new Set([
	code.lineFeed,
	code.carriageReturn,
	code.lineSeparator,
	code.paragraphSeparator
]);

function isLineTerminator(character: number): boolean {
	return lineTerminators.has(character);
}

/**
`\s`: the ECMAScript white space and line terminator characters.
*/
function isSpace(character: number): boolean {
	return (
		(character >= code.tab && character <= code.carriageReturn) ||
		character === code.space ||
		character === code.noBreakSpace ||
		character === code.ogham ||
		(character >= code.enQuad && character <= code.hairSpace) ||
		character === code.lineSeparator ||
		character === code.paragraphSeparator ||
		character === code.narrowNoBreakSpace ||
		character === code.mediumMathematicalSpace ||
		character === code.ideographicSpace ||
		character === code.byteOrderMark
	);
}

/**
`[^\s,;}]`: a character of an unquoted value.
*/
function isPlainValueCharacter(character: number): boolean {
	return (
		!isSpace(character) &&
		character !== code.comma &&
		character !== code.semicolon &&
		character !== code.rightCurlyBracket
	);
}

function isNameSeparator(character: number): boolean {
	return character === code.hyphen || character === code.lowLine;
}

function characterAt(text: ScannedText, index: number): number {
	return text.codePointAt(index) ?? noCharacter;
}

/**
The number of UTF-16 code units in a character, so a scan can step over a
character outside the Basic Multilingual Plane as a regular expression with
the `u` flag does.
*/
function characterLength(character: number): number {
	return character > 0xff_ff ? 2 : 1;
}

/**
Returns the index after the lower-case ASCII `letters` at `index`, compared
case-insensitively, or -1 when they are not there.
*/
function matchLetters(
	text: ScannedText,
	index: number,
	letters: string
): number {
	if (index + letters.length > text.length) {
		return -1;
	}

	for (let offset = 0; offset < letters.length; offset += 1) {
		if (
			fold(characterAt(text, index + offset)) !== letters.codePointAt(offset)
		) {
			return -1;
		}
	}

	return index + letters.length;
}

function skipSpaces(text: ScannedText, index: number): number {
	let end = index;

	while (end < text.length && isSpace(characterAt(text, end))) {
		end += 1;
	}

	return end;
}

/**
Returns the end of the run of `[^\s,;}]` characters at `index`, or -1 when
the run is empty.
*/
function plainValueEnd(text: ScannedText, index: number): number {
	let end = index;

	while (end < text.length && isPlainValueCharacter(characterAt(text, end))) {
		end += 1;
	}

	return end === index ? -1 : end;
}

/**
A part of a keyword: lower-case letters, or an optional character that the
predicate accepts.
*/
type KeywordPart = string | ((character: number) => boolean);

/**
A credential word such as `password` or `api-key`. Each keyword has at most
one optional character, so a match reads at most twice its length.
*/
class Keyword {
	readonly firstLetter: number;

	constructor(private readonly parts: readonly [string, ...KeywordPart[]]) {
		this.firstLetter = parts[0].codePointAt(0) ?? noCharacter;
	}

	private matchesFrom(
		text: ScannedText,
		index: number,
		partIndex: number
	): boolean {
		const part = this.parts[partIndex];

		if (part === undefined) {
			return true;
		}

		if (typeof part === 'string') {
			const end = matchLetters(text, index, part);

			return end !== -1 && this.matchesFrom(text, end, partIndex + 1);
		}

		const character = characterAt(text, index);

		if (
			character !== noCharacter &&
			part(character) &&
			this.matchesFrom(text, index + characterLength(character), partIndex + 1)
		) {
			return true;
		}

		return this.matchesFrom(text, index, partIndex + 1);
	}

	occursAt(text: ScannedText, index: number): boolean {
		return this.matchesFrom(text, index, 0);
	}
}

/**
A set of keywords. It reads the character at a position once and tries only
the keywords that start with that letter.
*/
class Keywords {
	constructor(private readonly keywords: readonly Keyword[]) {}

	occurAt(text: ScannedText, index: number): boolean {
		const first = fold(characterAt(text, index));

		for (const keyword of this.keywords) {
			if (keyword.firstLetter === first && keyword.occursAt(text, index)) {
				return true;
			}
		}

		return false;
	}
}

/**
The credential words for keys and options. The field rules and the argument
list pass use the same words.
*/
const credentialKeywords = new Keywords([
	new Keyword(['passcode']),
	new Keyword(['passphrase']),
	new Keyword(['password']),
	new Keyword(['secret']),
	new Keyword(['token']),
	new Keyword(['credential']),
	new Keyword(['private', (character) => !isLineTerminator(character), 'key']),
	new Keyword(['signature']),
	new Keyword(['authorization']),
	new Keyword(['cookie']),
	new Keyword(['api', isNameSeparator, 'key'])
]);

/**
Returns the end of a value that starts with a quotation mark at `index`: after
the closing quotation mark, or the end of the text. A backslash escapes the
next character.
*/
function quotedValueEnd(
	text: ScannedText,
	index: number,
	quotationMark: number
): number {
	let end = index + 1;

	while (end < text.length) {
		const character = characterAt(text, end);

		if (character === code.backslash) {
			end += 2;
			continue;
		}

		if (character === quotationMark) {
			return end + 1;
		}

		end += 1;
	}

	return text.length;
}

/**
Returns the end of `(?:Basic|Bearer)\s+[^\s,;}]+` at `index`, or -1.
*/
function authenticationValueEnd(text: ScannedText, index: number): number {
	const scheme = Math.max(
		matchLetters(text, index, 'basic'),
		matchLetters(text, index, 'bearer')
	);

	if (scheme === -1) {
		return -1;
	}

	const credentials = skipSpaces(text, scheme);

	if (credentials === scheme) {
		return -1;
	}

	return plainValueEnd(text, credentials);
}

/**
Returns the end of the value at `index`, or -1 when no value starts there. A
value is quoted, an authentication scheme followed by its credentials, or a
run of `[^\s,;}]` characters.
*/
function keyValueEnd(text: ScannedText, index: number): number {
	const first = characterAt(text, index);

	if (first === code.quotationMark || first === code.apostrophe) {
		return quotedValueEnd(text, index, first);
	}

	const authentication = authenticationValueEnd(text, index);

	if (authentication !== -1) {
		return authentication;
	}

	return plainValueEnd(text, index);
}

/**
Returns the index after `["']?\s*[:=]` at `index`, or -1.
*/
function assignmentEnd(text: ScannedText, index: number): number {
	const first = characterAt(text, index);
	const afterQuote =
		first === code.quotationMark || first === code.apostrophe
			? index + 1
			: index;
	const operator = skipSpaces(text, afterQuote);
	const character = characterAt(text, operator);

	return character === code.colon || character === code.equalsSign
		? operator + 1
		: -1;
}

/**
Returns the end of an option value at `index`: a quoted value, or a run of
non-space characters.
*/
function optionValueEnd(text: ScannedText, index: number): number {
	const first = characterAt(text, index);

	if (first === code.quotationMark || first === code.apostrophe) {
		return quotedValueEnd(text, index, first);
	}

	let end = index;

	while (end < text.length && !isSpace(characterAt(text, end))) {
		end += 1;
	}

	return end;
}

/**
Returns `[redacted]`, inside the quotation marks of the value at `index` when
the value is quoted.
*/
function quotedRedaction(text: ScannedText, index: number): string {
	const first = characterAt(text, index);

	if (first !== code.quotationMark && first !== code.apostrophe) {
		return redacted;
	}

	const quotationMark = String.fromCodePoint(first);

	return `${quotationMark}${redacted}${quotationMark}`;
}

/**
Builds the redacted copy of a text from the ranges that a scan replaces.
*/
class Redaction {
	private result = '';

	private copied = 0;

	constructor(private readonly text: ScannedText) {}

	/**
	Keeps the text before `start`, replaces the text from `start` to `end` with
	`replacement`, and continues after `end`.
	*/
	replace(start: number, end: number, replacement: string): void {
		this.result += `${this.text.slice(this.copied, start)}${replacement}`;
		this.copied = end;
	}

	toString(): string {
		return `${this.result}${this.text.slice(this.copied)}`;
	}
}

/**
A run of key or option characters.
*/
interface Run {
	readonly end: number;
	readonly hasKeyword: boolean;
}

/**
Reads the run of characters at `index` that `isRunCharacter` accepts, and
checks whether a credential word starts within the run at or after
`keywordStart`.
*/
function readRun(
	text: ScannedText,
	index: number,
	isRunCharacter: (character: number) => boolean,
	keywordStart: number
): Run {
	let end = index;
	let hasKeyword = false;

	while (end < text.length && isRunCharacter(characterAt(text, end))) {
		hasKeyword ||= end >= keywordStart && credentialKeywords.occurAt(text, end);
		end += 1;
	}

	return { end, hasKeyword };
}

/**
Whether a match can start at `index`: the character before it, if any, is not
a key character.
*/
function isRunStart(text: ScannedText, index: number): boolean {
	return index === 0 || !isKeyCharacter(characterAt(text, index - 1));
}

/**
Redacts the value of each credential key, as in `token=value`,
`"password": "value"` or `secret: Bearer value`.

A key is a whole run of word characters, dots and hyphens that contains a
credential word. An optional quotation mark, a colon or an equals sign, and
optional spaces separate it from the value. A quoted value ends at its closing
quotation mark or at the end of the text. The value keeps its quotation marks
around `[redacted]`.

Each run is read once, and a replaced value is not read again, so the scan
reads each character a bounded number of times.
*/
export function redactKeyValues(text: ScannedText): string {
	const redaction = new Redaction(text);
	let index = 0;

	while (index < text.length) {
		if (!isKeyCharacter(characterAt(text, index)) || !isRunStart(text, index)) {
			index += 1;
			continue;
		}

		const key = readRun(text, index, isKeyCharacter, index);
		const assignment = key.hasKeyword ? assignmentEnd(text, key.end) : -1;

		if (assignment === -1) {
			index = key.end;
			continue;
		}

		const value = skipSpaces(text, assignment);
		const end = keyValueEnd(text, value);

		if (end === -1) {
			index = key.end;
			continue;
		}

		redaction.replace(value, end, quotedRedaction(text, value));
		index = end;
	}

	return redaction.toString();
}

/**
Redacts the value that follows a credential option in a command line, as in
`--read-password value` or `-api-key 'value'`.

An option starts with a hyphen that does not follow a word character, dot or
hyphen, and it is the whole run of word characters and hyphens from there, at
least two characters long. It is a credential option when a credential word
starts after its first hyphen. The optional character in `private.?key` can be
the character after the option, so `--private key value` redacts `key`. One or
more spaces separate the option from its value. A quoted value ends at its
closing quotation mark or at the end of the text, and it keeps its quotation
marks around `[redacted]`. Any other value is a run of non-space characters.

Each run is read once, and a replaced value is not read again, so the scan
reads each character a bounded number of times.
*/
export function redactOptionValues(text: ScannedText): string {
	const redaction = new Redaction(text);
	let index = 0;

	while (index < text.length) {
		if (characterAt(text, index) !== code.hyphen || !isRunStart(text, index)) {
			index += 1;
			continue;
		}

		const option = readRun(text, index, isOptionCharacter, index + 1);
		const value = skipSpaces(text, option.end);

		if (
			!option.hasKeyword ||
			option.end - index < 2 ||
			value === option.end ||
			value === text.length
		) {
			index = option.end;
			continue;
		}

		const end = optionValueEnd(text, value);

		redaction.replace(value, end, quotedRedaction(text, value));
		index = end;
	}

	return redaction.toString();
}
