#!/usr/bin/env node
import process, { argv } from 'node:process';

import { runAction } from './program.ts';

process.exitCode = await runAction(argv);
