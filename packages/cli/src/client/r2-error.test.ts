import { describe, expect, it } from 'vitest';

import { parseR2Error, type R2ErrorBody } from './r2-error.ts';

describe('parseR2Error', () => {
	it.each([
		{
			name: 'an expired presigned request',
			body: '<?xml version="1.0" encoding="UTF-8"?><Error><Code>ExpiredRequest</Code><Message>Request has expired</Message></Error>',
			expected: {
				code: 'ExpiredRequest',
				message: 'Request has expired'
			} satisfies R2ErrorBody
		},
		{
			name: 'a signature mismatch',
			body: '<Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match</Message></Error>',
			expected: {
				code: 'SignatureDoesNotMatch',
				message: 'The request signature we calculated does not match'
			} satisfies R2ErrorBody
		},
		{
			name: 'a code with no message',
			body: '<Error><Code>AccessDenied</Code></Error>',
			expected: { code: 'AccessDenied', message: '' } satisfies R2ErrorBody
		}
	])('parses $name', ({ body, expected }) => {
		expect(parseR2Error(body)).toStrictEqual(expected);
	});

	it.each([
		{ name: 'an empty body', body: '' },
		{ name: 'plain text', body: 'Request has expired' },
		{
			name: 'XML without a code',
			body: '<Error><Message>nope</Message></Error>'
		}
	])('returns undefined for $name', ({ body }) => {
		expect(parseR2Error(body)).toBeUndefined();
	});
});
