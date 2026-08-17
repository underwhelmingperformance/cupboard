import { describe, expect, it } from 'vitest';

import {
	evaluatePreconditions,
	type PreconditionOutcome
} from './conditional.ts';
import type { ObjectStat } from './ports.ts';

const stat: ObjectStat = {
	size: 10,
	etag: 'abc',
	contentType: 'application/octet-stream',
	lastModified: new Date('2026-01-02T03:04:05.000Z')
};

const before = 'Fri, 02 Jan 2026 03:04:04 GMT';
const same = 'Fri, 02 Jan 2026 03:04:05 GMT';
const after = 'Fri, 02 Jan 2026 03:04:06 GMT';

describe('evaluatePreconditions', () => {
	it.each<{
		name: string;
		headers: Record<string, string>;
		expected: PreconditionOutcome;
	}>([
		{ name: 'no conditions', headers: {}, expected: 'ok' },

		{
			name: 'If-Match exact',
			headers: { 'if-match': '"abc"' },
			expected: 'ok'
		},
		{ name: 'If-Match wildcard', headers: { 'if-match': '*' }, expected: 'ok' },
		{
			name: 'If-Match list including the etag',
			headers: { 'if-match': '"x", "abc"' },
			expected: 'ok'
		},
		{
			name: 'If-Match mismatch',
			headers: { 'if-match': '"other"' },
			expected: 'precondition-failed'
		},

		{
			name: 'If-Unmodified-Since after last-modified',
			headers: { 'if-unmodified-since': after },
			expected: 'ok'
		},
		{
			name: 'If-Unmodified-Since before last-modified',
			headers: { 'if-unmodified-since': before },
			expected: 'precondition-failed'
		},
		{
			name: 'If-Match takes precedence over If-Unmodified-Since',
			headers: { 'if-match': '"abc"', 'if-unmodified-since': before },
			expected: 'ok'
		},
		{
			name: 'If-Unmodified-Since with an unparseable date is ignored',
			headers: { 'if-unmodified-since': 'not a date' },
			expected: 'ok'
		},

		{
			name: 'If-None-Match match',
			headers: { 'if-none-match': '"abc"' },
			expected: 'not-modified'
		},
		{
			name: 'If-None-Match wildcard',
			headers: { 'if-none-match': '*' },
			expected: 'not-modified'
		},
		{
			name: 'If-None-Match mismatch',
			headers: { 'if-none-match': '"other"' },
			expected: 'ok'
		},

		{
			name: 'If-Modified-Since not modified after',
			headers: { 'if-modified-since': after },
			expected: 'not-modified'
		},
		{
			name: 'If-Modified-Since modified after',
			headers: { 'if-modified-since': before },
			expected: 'ok'
		},
		{
			name: 'If-Modified-Since at the same second',
			headers: { 'if-modified-since': same },
			expected: 'not-modified'
		},

		{
			name: 'If-None-Match takes precedence over If-Modified-Since',
			headers: { 'if-none-match': '"other"', 'if-modified-since': after },
			expected: 'ok'
		},
		{
			name: 'If-Modified-Since with an unparseable date is ignored',
			headers: { 'if-modified-since': 'not a date' },
			expected: 'ok'
		}
	])('$name returns $expected', ({ headers, expected }) => {
		expect(evaluatePreconditions(new Headers(headers), stat)).toBe(expected);
	});
});
