import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
	checkDomainOption,
	cloudflareZoneCandidates,
	domainProblem,
	InvalidDomainError
} from './domain.ts';

describe('cloudflareZoneCandidates', () => {
	it.each([
		{
			hostname: 'api.cache.example.co.uk',
			zones: ['api.cache.example.co.uk', 'cache.example.co.uk', 'example.co.uk']
		},
		{
			hostname: 'user.github.io',
			zones: ['user.github.io']
		},
		{
			hostname: 'CACHE.Example.COM',
			zones: ['cache.example.com', 'example.com']
		}
	])('lists candidate zones for $hostname', ({ hostname, zones }) => {
		expect(cloudflareZoneCandidates(hostname)).toStrictEqual(zones);
	});
});

function thrownBy(run: () => unknown): unknown {
	let thrown: unknown;

	try {
		run();
	} catch (error) {
		thrown = error;
	}

	return thrown;
}

describe('domainProblem', () => {
	it.each([
		['cache.example.com'],
		['a-b.example.co.uk'],
		['xn--bcher-kva.example']
	])('accepts %s', (value) => {
		expect(domainProblem(value)).toBeUndefined();
	});

	it.each([
		['', 'empty'],
		['https://cache.example.com', 'scheme-or-path'],
		['cache.example.com/path', 'scheme-or-path'],
		['localhost', 'not-fully-qualified'],
		['-bad.example.com', 'invalid-label'],
		['bad-.example.com', 'invalid-label'],
		[`${'a'.repeat(254)}.com`, 'too-long']
	])('rejects %s', (value, problem) => {
		expect(domainProblem(value)).toBe(problem);
	});
});

describe('checkDomainOption', () => {
	it('returns a valid domain unchanged', () => {
		expect(checkDomainOption('cache.example.com')).toBe('cache.example.com');
	});

	it('throws the typed error for an invalid domain', () => {
		const error = z
			.instanceof(InvalidDomainError)
			.parse(thrownBy(() => checkDomainOption('not a domain')));

		expect({
			name: error.name,
			domain: error.domain,
			problem: error.problem
		}).toStrictEqual({
			name: 'InvalidDomainError',
			domain: 'not a domain',
			problem: 'not-fully-qualified'
		});
	});
});
