import { Option } from 'commander';

/**
 * Adds `--private-cache <name>` to a command that targets one cache. `--cache`
 * selects a public cache, while `--private-cache` selects a private cache.
 * Commander rejects a command line that sets both options.
 *
 * `action` supplies the opening verb phrase for the option description, such as
 * `'push to'` or `'target'`. This function capitalises its first letter.
 */
export function privateCacheOption(action: string): Option {
	const opening = action.charAt(0).toUpperCase() + action.slice(1);

	return new Option(
		'--private-cache <name>',
		`${opening} a private cache.`
	).conflicts('cache');
}
