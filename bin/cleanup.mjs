#!/usr/bin/env node
// Entry point for `npx cleanup ...`. Runs the TypeScript CLI through tsx, so arguments go
// straight to the tool instead of through `npm run`'s own option parsing.
import { register } from 'tsx/esm/api';

register();
await import('../src/cli.ts');
