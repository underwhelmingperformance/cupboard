import { describe, expect, it } from 'vitest';

import {
	applyTransform,
	captureGroups,
	compileCapture,
	InvalidCapturePatternError,
	SubstitutionError
} from './capture.ts';

const prReferencePattern = String.raw`^refs/pull/(?<pull_request_number>\d+)/merge$`;

describe('compileCapture', () => {
	it('compiles an anchored pattern with a named group', () => {
		expect(captureGroups(prReferencePattern)).toStrictEqual([
			'pull_request_number'
		]);
	});

	it('exposes several named groups', () => {
		expect(
			captureGroups('^(?<branch>[a-z]+)-(?<platform>[a-z]+)$')
		).toStrictEqual(['branch', 'platform']);
	});

	it.each([
		['unanchored', String.raw`refs/pull/(?<n>\d+)/merge`],
		['no named group', String.raw`^refs/pull/\d+/merge$`],
		['a backreference (unsupported by RE2)', String.raw`^(?<a>.)\1$`]
	])('rejects %s', (_name, pattern) => {
		expect(() => compileCapture(pattern)).toThrow(InvalidCapturePatternError);
	});
});

describe('applyTransform', () => {
	it('copies a claim directly', () => {
		expect(applyTransform({ claim: 'sub' }, { sub: 'value' })).toBe('value');
	});

	it('extracts a named capture group', () => {
		expect(
			applyTransform(
				{
					claim: 'ref',
					capture: { pattern: prReferencePattern, group: 'pull_request_number' }
				},
				{ ref: 'refs/pull/123/merge' }
			)
		).toBe('123');
	});

	it('extracts one of several groups from one claim', () => {
		const capture = {
			pattern: '^(?<branch>[a-z]+)-(?<platform>[a-z0-9]+)$',
			group: 'platform'
		};

		expect(applyTransform({ claim: 'ref', capture }, { ref: 'main-x64' })).toBe(
			'x64'
		);
	});

	it('slugs a claim value', () => {
		expect(
			applyTransform({ claim: 'ref', slug: true }, { ref: 'Feature/Foo' })
		).toBe('feature-foo');
	});

	it('throws when the claim is absent', () => {
		expect(() => applyTransform({ claim: 'ref' }, {})).toThrow(
			SubstitutionError
		);
	});

	it('throws when the claim does not match the capture', () => {
		expect(() =>
			applyTransform(
				{
					claim: 'ref',
					capture: { pattern: prReferencePattern, group: 'pull_request_number' }
				},
				{ ref: 'refs/heads/main' }
			)
		).toThrow(SubstitutionError);
	});
});
