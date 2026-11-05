import {
	getDefaultAutoSelectFamilyAttemptTimeout,
	setDefaultAutoSelectFamilyAttemptTimeout
} from 'node:net';

import { expect, it, onTestFinished } from 'vitest';

import { configureConnectionAttempts } from './connection-attempts.ts';

it('gives each address 2.5 seconds to connect', () => {
	const previous = getDefaultAutoSelectFamilyAttemptTimeout();
	onTestFinished(() => {
		setDefaultAutoSelectFamilyAttemptTimeout(previous);
	});

	configureConnectionAttempts();

	expect(getDefaultAutoSelectFamilyAttemptTimeout()).toBe(2500);
});
