import {
	cancel,
	confirm,
	intro,
	isCancel,
	log,
	note,
	outro,
	select,
	spinner
} from '@clack/prompts';
import type { Reporter, ResultRow } from '@cupboard/reporter';
import pc from 'picocolors';

import { openBrowser } from '../io/open-browser.ts';

import type { AccountSummary } from './cloudflare-api.ts';

/**
 * Lays out label/value rows with aligned columns, ready for a clack note.
 * Labels are dimmed so the values carry the emphasis.
 */
export function formatRows(rows: readonly ResultRow[]): string {
	const width = Math.max(...rows.map((row) => row.label.length));

	return rows
		.map((row) => `${pc.dim(row.label.padEnd(width))}  ${row.value}`)
		.join('\n');
}

/**
 * Everything `cupboard deploy` says or asks. One clack-based visual language
 * for the whole command: spinners for phases, notes for structured facts,
 * prompts for the decisions, and a clean cancel path throughout.
 */
export interface DeployUi {
	intro(): void;
	outro(message: string): void;
	cancelled(message: string): void;
	info(message: string): void;
	success(message: string): void;
	warn(message: string): void;
	note(title: string, rows: readonly ResultRow[]): void;
	/** False when declined or cancelled; the caller aborts either way. */
	confirmDeploy(): Promise<boolean>;
	/** Undefined when cancelled. */
	chooseAccount(
		accounts: readonly AccountSummary[]
	): Promise<string | undefined>;
	openBrowser(url: string): void;
	/** A {@link Reporter} rendering phases as clack spinners. */
	reporter(): Reporter;
}

export function createDeployUi(): DeployUi {
	return {
		intro() {
			intro(pc.bold('cupboard deploy'));
		},

		outro(message) {
			outro(message);
		},

		cancelled(message) {
			cancel(message);
		},

		info(message) {
			log.info(message);
		},

		success(message) {
			log.success(message);
		},

		warn(message) {
			log.warn(message);
		},

		note(title, rows) {
			note(formatRows(rows), title);
		},

		async confirmDeploy() {
			const answer = await confirm({
				message: 'Deploy to Cloudflare with the plan above?',
				initialValue: false
			});

			return answer === true;
		},

		async chooseAccount(accounts) {
			const chosen = await select({
				message: 'Which Cloudflare account?',
				options: accounts.map((account) => ({
					value: account.id,
					label: account.name,
					hint: account.id
				}))
			});

			return isCancel(chosen) ? undefined : chosen;
		},

		openBrowser(url) {
			openBrowser(url, {
				info: (message) => {
					log.info(message);
				},
				warn: (message) => {
					log.warn(message);
				}
			});
		},

		reporter() {
			return clackReporter();
		}
	};
}

/**
 * Adapts the deploy pipeline's {@link Reporter} contract onto clack: each
 * phase is a spinner whose text accumulates the phase's facts, warnings become
 * clack warnings, and the closing result rows become a note.
 */
function clackReporter(): Reporter {
	return {
		async phase(label, body) {
			const indicator = spinner();
			indicator.start(label);

			const facts: string[] = [];

			try {
				const value = await body({
					fact(factLabel, factValue) {
						facts.push(`${factLabel} ${String(factValue)}`);
						indicator.message(`${label} ${pc.dim(`· ${facts.join(' · ')}`)}`);
					}
				});

				indicator.stop(
					facts.length === 0
						? label
						: `${label} ${pc.dim(`· ${facts.join(' · ')}`)}`
				);

				return value;
			} catch (error) {
				indicator.error(`${label} ${pc.red('failed')}`);

				throw error;
			}
		},

		result(rows) {
			note(formatRows(rows), 'Deployed');
		},

		warn(label, value) {
			log.warn(value === undefined ? label : `${label}: ${value}`);
		},

		info(message) {
			log.info(message);
		}
	};
}
