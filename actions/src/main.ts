#!/usr/bin/env node
import process, { argv } from 'node:process';

import { initialiseTracing } from '@cupboard/shared/node-tracing';

import { runAction } from './program.ts';

initialiseTracing();
process.exitCode = await runAction(argv);
