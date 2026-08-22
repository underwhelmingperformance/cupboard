const shortWeekdays = [
	'Sun',
	'Mon',
	'Tue',
	'Wed',
	'Thu',
	'Fri',
	'Sat'
] as const;
const longWeekdays = [
	'Sunday',
	'Monday',
	'Tuesday',
	'Wednesday',
	'Thursday',
	'Friday',
	'Saturday'
] as const;
const months = [
	'Jan',
	'Feb',
	'Mar',
	'Apr',
	'May',
	'Jun',
	'Jul',
	'Aug',
	'Sep',
	'Oct',
	'Nov',
	'Dec'
] as const;

interface HttpDateParts {
	readonly weekday: number;
	readonly day: number;
	readonly month: number;
	readonly year: number;
	readonly hour: number;
	readonly minute: number;
	readonly second: number;
}

interface DatePartIndexes {
	readonly weekday: number;
	readonly day: number;
	readonly month: number;
	readonly year?: number;
	readonly hour: number;
	readonly minute: number;
	readonly second: number;
}

/**
 * Parses an HTTP date without accepting JavaScript's additional date formats.
 */
export function parseHttpDate(
	value: string,
	nowMilliseconds: number = Date.now()
): number | undefined {
	const parts =
		parsePreferredDate(value) ??
		parseObsoleteRfc850Date(value, nowMilliseconds) ??
		parseObsoleteAsctimeDate(value);

	if (parts === undefined || parts.year < 1601) {
		return undefined;
	}

	const parsed = new Date(0);
	parsed.setUTCFullYear(parts.year, parts.month, parts.day);
	parsed.setUTCHours(
		parts.hour,
		parts.minute,
		parts.second === 60 ? 59 : parts.second,
		0
	);

	if (
		parsed.getUTCFullYear() !== parts.year ||
		parsed.getUTCMonth() !== parts.month ||
		parsed.getUTCDate() !== parts.day ||
		parsed.getUTCHours() !== parts.hour ||
		parsed.getUTCMinutes() !== parts.minute ||
		parsed.getUTCSeconds() !== (parts.second === 60 ? 59 : parts.second) ||
		parsed.getUTCDay() !== parts.weekday
	) {
		return undefined;
	}

	return parsed.getTime() + (parts.second === 60 ? 1000 : 0);
}

function parsePreferredDate(value: string): HttpDateParts | undefined {
	const match =
		/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(
			value
		);

	if (match === null) {
		return undefined;
	}

	return dateParts(match, shortWeekdays, {
		weekday: 1,
		day: 2,
		month: 3,
		year: 4,
		hour: 5,
		minute: 6,
		second: 7
	});
}

function parseObsoleteRfc850Date(
	value: string,
	nowMilliseconds: number
): HttpDateParts | undefined {
	const match =
		/^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(
			value
		);

	if (match === null) {
		return undefined;
	}

	const currentYear = new Date(nowMilliseconds).getUTCFullYear();
	let year = Math.floor(currentYear / 100) * 100 + Number(match[4]);

	if (year > currentYear + 50) {
		year -= 100;
	}

	return dateParts(
		match,
		longWeekdays,
		{
			weekday: 1,
			day: 2,
			month: 3,
			hour: 5,
			minute: 6,
			second: 7
		},
		year
	);
}

function parseObsoleteAsctimeDate(value: string): HttpDateParts | undefined {
	const match =
		/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( [1-9]|[12]\d|3[01]) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(
			value
		);

	if (match === null) {
		return undefined;
	}

	return dateParts(match, shortWeekdays, {
		weekday: 1,
		day: 3,
		month: 2,
		year: 7,
		hour: 4,
		minute: 5,
		second: 6
	});
}

function dateParts(
	match: RegExpExecArray,
	weekdays: readonly string[],
	indexes: DatePartIndexes,
	yearOverride?: number
): HttpDateParts | undefined {
	const weekday = weekdays.indexOf(match[indexes.weekday] ?? '');
	const month = months.indexOf(
		(match[indexes.month] ?? '') as (typeof months)[number]
	);
	const year =
		yearOverride ??
		Number(indexes.year === undefined ? undefined : match[indexes.year]);
	const day = Number((match[indexes.day] ?? '').trim());
	const hour = Number(match[indexes.hour]);
	const minute = Number(match[indexes.minute]);
	const second = Number(match[indexes.second]);

	if (
		weekday === -1 ||
		month === -1 ||
		!Number.isSafeInteger(year) ||
		day < 1 ||
		day > 31 ||
		hour < 0 ||
		hour > 23 ||
		minute < 0 ||
		minute > 59 ||
		second < 0 ||
		second > 60 ||
		(second === 60 && (hour !== 23 || minute !== 59))
	) {
		return undefined;
	}

	return { weekday, day, month, year, hour, minute, second };
}

/**
 * Applies HTTP's weak entity-tag comparison to an If-None-Match field.
 */
export function isWeakEtagMatch(
	ifNoneMatch: string,
	etag: string | null
): boolean {
	const trimmed = ifNoneMatch.trim();

	if (trimmed === '*') {
		return true;
	}

	if (etag === null) {
		return false;
	}

	const target = parseEntityTag(etag.trim());
	const candidates = parseEntityTagList(trimmed);

	return target !== undefined && candidates?.includes(target) === true;
}

function parseEntityTagList(value: string): readonly string[] | undefined {
	const tags: string[] = [];
	let offset = 0;

	while (offset < value.length) {
		offset = skipOptionalWhitespaceAndCommas(value, offset);

		if (offset >= value.length) {
			break;
		}

		const parsed = parseEntityTagAt(value, offset);

		if (parsed === undefined) {
			return undefined;
		}

		tags.push(parsed.tag);
		offset = skipOptionalWhitespace(value, parsed.end);

		if (offset < value.length && value[offset] !== ',') {
			return undefined;
		}
	}

	return tags.length === 0 ? undefined : tags;
}

function parseEntityTag(value: string): string | undefined {
	const parsed = parseEntityTagAt(value, 0);

	return parsed?.end === value.length ? parsed.tag : undefined;
}

function parseEntityTagAt(
	value: string,
	offset: number
): { readonly tag: string; readonly end: number } | undefined {
	let cursor = offset;

	if (value.startsWith('W/', cursor)) {
		cursor += 2;
	}

	if (value[cursor] !== '"') {
		return undefined;
	}

	const opaqueStart = cursor;
	cursor += 1;

	while (cursor < value.length && value[cursor] !== '"') {
		const code = value.codePointAt(cursor) ?? -1;

		if (!(
			code === 0x21 ||
			(code >= 0x23 && code <= 0x7e) ||
			(code >= 0x80 && code <= 0xff)
		)) {
			return undefined;
		}

		cursor += 1;
	}

	if (value[cursor] !== '"') {
		return undefined;
	}

	return { tag: value.slice(opaqueStart, cursor + 1), end: cursor + 1 };
}

function skipOptionalWhitespace(value: string, offset: number): number {
	let cursor = offset;

	while (value[cursor] === ' ' || value[cursor] === '\t') {
		cursor += 1;
	}

	return cursor;
}

function skipOptionalWhitespaceAndCommas(
	value: string,
	offset: number
): number {
	let cursor = offset;

	while (cursor < value.length) {
		const next = skipOptionalWhitespace(value, cursor);

		if (value[next] !== ',') {
			return next;
		}

		cursor = next + 1;
	}

	return cursor;
}
