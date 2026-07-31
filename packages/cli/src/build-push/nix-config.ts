/** The environment shape the child composition reads and returns. */
export type ChildEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * The child invocation's environment, with the invocation's post-build hook
 * applied through `NIX_CONFIG`: the setting is appended to any existing value
 * (created when absent), and within `NIX_CONFIG` the last assignment wins and
 * the variable outranks every configuration file, so the appended setting is
 * effective while the operator's own files continue to apply. The environment
 * is otherwise inherited unchanged; in particular `NIX_USER_CONF_FILES` is
 * left alone, since setting it would replace the operator's user-config
 * lookup.
 */
export function environmentWithPostBuildHook(
	environment: ChildEnvironment,
	hookScriptPath: string
): Record<string, string | undefined> {
	const setting = `post-build-hook = ${hookScriptPath}`;
	const existing = environment.NIX_CONFIG;

	if (existing === undefined || existing === '') {
		return { ...environment, NIX_CONFIG: setting };
	}

	const separator = existing.endsWith('\n') ? '' : '\n';

	return { ...environment, NIX_CONFIG: `${existing}${separator}${setting}` };
}
