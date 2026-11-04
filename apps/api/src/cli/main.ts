import { runCli } from './run.js';

process.exitCode = await runCli(process.argv.slice(2), {
  stdout: value => process.stdout.write(value.endsWith('\n') ? value : `${value}\n`),
  stderr: value => process.stderr.write(`${value}\n`),
});
