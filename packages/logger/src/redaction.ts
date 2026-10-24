import type { LogRecord, Sink } from '@logtape/logtape';
import {
	JWT_PATTERN,
	redactByField,
	redactByPattern,
	type RedactionPatterns
} from '@logtape/redaction';

const traversalLimits = { maxDepth: 8, maxProperties: 64 };

const textPatterns: RedactionPatterns = [
	{
		pattern:
			/(\b(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie)["']?\s*[:=]\s*)[^\r\n]+/giu,
		replacement: '$1[redacted]'
	},
	{
		pattern: /https?:\/\/[^\r\n]+/giu,
		replacement: (text) => {
			const url = URL.parse(text);

			if (url === null) {
				return '[redacted URL]';
			}

			return /[\s"'<>]|%(?:20|22|27|3c|3e)/iu.test(url.pathname)
				? `${url.origin}/`
				: `${url.origin}${url.pathname}`;
		}
	},
	{
		pattern:
			/(\b[\w.-]*(?:password|secret|token|authorization|cookie|credential|api[-_]?key)[\w.-]*["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:Basic|Bearer)\s+[^\s,;}]+|[^\s,;}]+)/giu,
		replacement: (_match, prefix: string, value: string) => {
			const quote = value.startsWith('"')
				? '"'
				: value.startsWith("'")
					? "'"
					: '';

			return `${prefix}${quote}[redacted]${quote}`;
		}
	},
	{
		pattern: /\b(Basic|Bearer)\s+[^\s,;"']+/giu,
		replacement: '$1 [redacted]'
	},
	JWT_PATTERN,
	{
		pattern: /[\s\S]{4097,}/gu,
		replacement: (text) => `${text.slice(0, 4096)}[truncated]`
	}
];

const redactOutput = redactByPattern(
	(record) => [record.properties, record.message.map(String).join('')],
	textPatterns,
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
		const [properties, ...message] = redactOutput(record);

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
			/pass(?:code|phrase|word)|secret|token|credential|private.?key|signature|authorization|cookie/i,
			/^(?:request|response)?body$|^headers$|^api[-_]?key$/i
		],
		action: () => '[redacted]'
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
