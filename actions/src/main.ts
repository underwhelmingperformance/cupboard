#!/usr/bin/env node
import process, { argv } from 'node:process';

import { configureConnectionAttempts } from '@cupboard/shared/connection-attempts';
import { initialiseTracing } from '@cupboard/shared/node-tracing';

import { runAction } from './program.ts';

configureConnectionAttempts();
initialiseTracing();
process.exitCode = await runAction(argv);
