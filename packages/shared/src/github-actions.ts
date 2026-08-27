import process from 'node:process';

/**
 * Whether this process runs inside a GitHub Actions job, per the environment
 * contract GitHub documents: `GITHUB_ACTIONS` is `'true'` on a runner.
 * https://docs.github.com/actions/reference/variables-reference
 */
export function isGithubActions(
	environment: Readonly<Record<string, string | undefined>> = process.env
): boolean {
	return environment.GITHUB_ACTIONS === 'true';
}

export interface CommandStream {
	write(chunk: string): unknown;
}

export interface WorkflowCommandStreams {
	readonly stdout?: CommandStream;
	readonly stderr?: CommandStream;
	readonly environment?: Readonly<Record<string, string | undefined>>;
	readonly rendering?: 'auto' | 'workflow' | 'plain';
}

export interface WorkflowCommands {
	debug(message: string): void;
	notice(message: string): void;
	warning(message: string): void;
	error(message: string): void;
	group(title: string): void;
	endGroup(): void;
	/**
	 * Registers `value` as a run secret. GitHub Actions replaces every later
	 * occurrence of it in the log with `***`, so call this before the value can
	 * reach any output. Outside Actions nothing reads the command and printing
	 * the value would disclose it, so this writes nothing.
	 */
	addMask(value: string): void;
}

// GitHub Actions turns a workflow command written on its own line into an
// annotation in the run summary and on the changed files; outside Actions the
// same call prints the plain message. The data after the `::level::` separator
// must escape the characters the command syntax reserves.
// https://docs.github.com/actions/reference/workflow-commands-for-github-actions
type AnnotationLevel = 'debug' | 'notice' | 'warning' | 'error';

function escapeData(message: string): string {
	return message
		.replaceAll('%', '%25')
		.replaceAll('\r', '%0D')
		.replaceAll('\n', '%0A');
}

/**
 * Builds the workflow-command emitters over the given streams. `workflow` and
 * `plain` select their respective rendering explicitly. `auto` uses workflow
 * syntax under GitHub Actions and plain messages elsewhere. Plain errors go to
 * stderr; all other output goes to stdout.
 */
export function workflowCommands(
	streams: WorkflowCommandStreams = {}
): WorkflowCommands {
	const out = streams.stdout ?? process.stdout;
	const errorOut = streams.stderr ?? process.stderr;
	const environment = streams.environment;
	const isWorkflowSyntax =
		streams.rendering === 'workflow' ||
		(streams.rendering !== 'plain' && isGithubActions(environment));

	const annotate = (level: AnnotationLevel, message: string): void => {
		if (isWorkflowSyntax) {
			out.write(`::${level}::${escapeData(message)}\n`);
			return;
		}

		const stream = level === 'error' ? errorOut : out;
		stream.write(`${message}\n`);
	};

	return {
		debug: (message) => {
			annotate('debug', message);
		},
		notice: (message) => {
			annotate('notice', message);
		},
		warning: (message) => {
			annotate('warning', message);
		},
		error: (message) => {
			annotate('error', message);
		},
		group: (title) => {
			if (isWorkflowSyntax) {
				out.write(`::group::${escapeData(title)}\n`);
				return;
			}

			out.write(`${title}\n`);
		},
		endGroup: () => {
			if (isWorkflowSyntax) {
				out.write('::endgroup::\n');
			}
		},
		addMask: (value) => {
			if (isWorkflowSyntax) {
				out.write(`::add-mask::${escapeData(value)}\n`);
			}
		}
	};
}
