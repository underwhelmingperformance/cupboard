import type { LogRecord, Sink } from '@logtape/logtape';
import { redactByField, redactByPattern } from '@logtape/redaction';

import { redactKeyValues, redactOptionValues } from './credential-scanner.ts';

const traversalLimits = { maxDepth: 8, maxProperties: 64 };

const redacted = '[redacted]';

const truncated = '[truncated]';

const credentialName =
	/pass(?:code|phrase|word)|secret|token|credential|private.?key|signature|authorization|cookie/iu;

const credentialOptionName = new RegExp(
	`${credentialName.source}|api[-_]?key`,
	'iu'
);

/**
Redacts every JSON Web Token in a run of base64url characters and dots. Each
search starts after the previous one, so the cost is linear in the length of
the run.

When the run ends where redaction cut the text, a token that starts in the run
can continue past the cut. The first `eyJ` that is not followed by two dots is
then redacted to the end of the run.
*/
function redactJsonWebTokens(run: string, isAtCut: boolean): string {
	let result = '';
	let offset = 0;
	let start = run.indexOf('eyJ');

	while (start !== -1) {
		const firstDot = run.indexOf('.', start);
		const secondDot = firstDot === -1 ? -1 : run.indexOf('.', firstDot + 1);

		if (secondDot === -1 && isAtCut) {
			result += `${run.slice(offset, start)}[JWT REDACTED]`;
			offset = run.length;
			break;
		}

		if (secondDot === -1) {
			break;
		}

		const nextDot = run.indexOf('.', secondDot + 1);
		const end = nextDot === -1 ? run.length : nextDot;

		result += `${run.slice(offset, start)}[JWT REDACTED]`;
		offset = end;
		start = run.indexOf('eyJ', end);
	}

	return `${result}${run.slice(offset)}`;
}

const maximumTextLength = 4096;

// The passes read at most this many characters of a string, which bounds their
// cost. A token that starts before the cut at `maximumTextLength` and is
// shorter than the margin is still redacted whole.
const scannedTextLength = maximumTextLength + 4096;

/**
The regular expressions that redaction applies to text. Each must run in time
linear in the length of the text, and the tests check this with recheck.
*/
export const textPatterns = {
	header:
		/(\b(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie)["']?\s*[:=]\s*)[^\r\n]+/giu,
	url: /https?:\/\/[^\r\n]+/giu,
	authentication: /\b(Basic|Bearer)\s+[^\s,;"']+/giu,
	githubToken: /\b(?:gh[opsur]_|github_pat_)(\w+)/gu,
	webTokenRun: /[\w.-]+/gu,
	wholeText: /[\s\S]+/gu
} as const;

/**
A pass over the text of one string. `isCut` is true when redaction cut the
string before the passes.
*/
type TextPass = (text: string, isCut: boolean) => string;

const textPasses: readonly TextPass[] = [
	(text) => text.replaceAll(textPatterns.header, '$1[redacted]'),
	(text) =>
		text.replaceAll(textPatterns.url, (match) => {
			const url = URL.parse(match);

			if (url === null) {
				return '[redacted URL]';
			}

			return /[\s"'<>]|%(?:20|22|27|3c|3e)/iu.test(url.pathname)
				? `${url.origin}/`
				: `${url.origin}${url.pathname}`;
		}),
	redactKeyValues,
	redactOptionValues,
	(text) => text.replaceAll(textPatterns.authentication, '$1 [redacted]'),
	(text) =>
		text.replaceAll(textPatterns.githubToken, (token, body: string) =>
			body.length < 20 ? token : redacted
		),
	(text, isCut) =>
		text.replaceAll(textPatterns.webTokenRun, (run, offset: number) =>
			redactJsonWebTokens(run, isCut && offset + run.length === text.length)
		)
];

/**
Returns at most the first `length` UTF-16 code units of `text`, or one more
when the last of them starts a surrogate pair, so the cut never splits a
character. Serialisation and the sinks both redact a record, so cutting the
result again must keep the same text: a cut one unit earlier would bring the
first character of `[truncated]` into the text on the second pass.
*/
function cutText(text: string, length: number): string {
	const last = text.codePointAt(length - 1) ?? 0;

	return text.slice(0, last > 0xff_ff ? length + 1 : length);
}

/**
Redacts credentials in one string and truncates it to `maximumTextLength`.
*/
function redactText(text: string): string {
	let result = cutText(text, scannedTextLength);
	const isCut = result.length < text.length;

	for (const pass of textPasses) {
		result = pass(result, isCut);
	}

	if (!isCut && result.length <= maximumTextLength) {
		return result;
	}

	return `${cutText(result, maximumTextLength)}${truncated}`;
}

function isCredentialOption(value: unknown): boolean {
	return (
		typeof value === 'string' &&
		/^--?[\w-]+$/u.test(value) &&
		credentialOptionName.test(value)
	);
}

/**
Redacts the value of each credential option in an argument list, such as the
`spawnargs` of a process that failed to start. The pattern rules see one
string at a time, so they cannot connect an option with the value in the next
element.
*/
function redactArgumentList(values: readonly unknown[]): unknown[] {
	return values.map((value, index) => {
		if (index > 0 && isCredentialOption(values[index - 1])) {
			return redacted;
		}

		if (typeof value !== 'string') {
			return value;
		}

		const separator = value.indexOf('=');

		if (separator === -1 || !isCredentialOption(value.slice(0, separator))) {
			return value;
		}

		return `${value.slice(0, separator)}=${redacted}`;
	});
}

/**
Copies a value with the credential option values in its argument lists
redacted. The copy keeps the traversal limits of the other redaction passes:
a value nested deeper than the limit becomes `[truncated]`, and an array or
object keeps only its first entries.
*/
function redactArgumentLists(
	value: unknown,
	copies: Map<object, unknown>,
	depth: number
): unknown {
	if (typeof value !== 'object' || value === null) {
		return value;
	}

	if (copies.has(value)) {
		return copies.get(value);
	}

	const isArray = Array.isArray(value);
	const prototype: unknown = Object.getPrototypeOf(value);

	if (!isArray && prototype !== null && prototype !== Object.prototype) {
		return value;
	}

	if (depth > traversalLimits.maxDepth) {
		return truncated;
	}

	if (isArray) {
		const copy: unknown[] = [];
		copies.set(value, copy);

		const items = redactArgumentList(
			value.slice(0, traversalLimits.maxProperties)
		);

		for (const item of items) {
			copy.push(redactArgumentLists(item, copies, depth + 1));
		}

		return copy;
	}

	const copy: Record<string, unknown> = {};
	copies.set(value, copy);

	for (const key of Object.keys(value).slice(
		0,
		traversalLimits.maxProperties
	)) {
		const item: unknown = Reflect.get(value, key);

		Object.defineProperty(copy, key, {
			value: redactArgumentLists(item, copies, depth + 1),
			enumerable: true,
			writable: true,
			configurable: true
		});
	}

	return copy;
}

// redactByPattern accepts only global regular expressions. This one matches
// each whole string, so redactText receives every string in the record.
const redactOutput = redactByPattern(
	(record) => [record.properties, record.message.map(String).join('')],
	[{ pattern: textPatterns.wholeText, replacement: redactText }],
	traversalLimits
);

const reservedProperties = [
	'level',
	'category',
	'msg',
	'timestamp',
	'trace_id',
	'span_id',
	'trace_flags',
	'requestId',
	'cfRay',
	'ray',
	'clientTraceId',
	'clientSpanId',
	'error',
	'errorDetails',
	'errorName',
	'errorMessage',
	'errorStack',
	'errorCause',
	'errorCauseStack',
	'logTruncated'
] as const;

export function prioritiseProperties(
	properties: Record<string, unknown>
): Record<string, unknown> {
	const keys = Object.keys(properties);
	const priority = reservedProperties.filter((key) =>
		Object.hasOwn(properties, key)
	);
	const ordered = [...new Set([...priority, ...keys])];
	const isTruncated = keys.length > traversalLimits.maxProperties;
	const capacity =
		traversalLimits.maxProperties -
		Number(isTruncated && !Object.hasOwn(properties, 'logTruncated'));
	const selected = Object.fromEntries(
		ordered.slice(0, capacity).map((key) => [key, properties[key]])
	);

	return {
		...(isTruncated && { logTruncated: true }),
		...selected,
		...(isTruncated && { logTruncated: true })
	};
}

/**
Applies the credential policy before a record reaches a sink.
*/
export function redactingSink(sink: Sink): Sink {
	const redactText: Sink = (record) => {
		const copies = new Map<object, unknown>();
		const [properties, ...message] = redactOutput({
			...record,
			message: record.message.map((part) =>
				redactArgumentLists(part, copies, 1)
			),
			properties: Object.fromEntries(
				Object.entries(record.properties).map(([key, value]) => [
					key,
					redactArgumentLists(value, copies, 1)
				])
			)
		});

		if (typeof properties !== 'object' || properties === null) {
			throw new TypeError('Redacted log properties must be an object');
		}

		sink({
			...record,
			message,
			rawMessage: message.map(String).join(''),
			properties: Object.fromEntries(Object.entries(properties))
		});
	};

	const redactFields = redactByField(redactText, {
		...traversalLimits,
		fieldPatterns: [
			credentialName,
			/^(?:request|response)?body$|^headers$|^api[-_]?key$/i
		],
		action: () => redacted
	});

	return (record) => {
		redactFields({
			...record,
			properties: prioritiseProperties(record.properties)
		});
	};
}

/**
Redacts structured output after errors have been serialised.
*/
export function redactLogProperties(
	properties: Record<string, unknown>
): Record<string, unknown> {
	let result = properties;
	const sink = redactingSink((record) => {
		result = record.properties;
	});
	const record: LogRecord = {
		timestamp: 0,
		category: [],
		level: 'trace',
		message: [],
		rawMessage: '',
		properties
	};

	sink(record);

	return result;
}
