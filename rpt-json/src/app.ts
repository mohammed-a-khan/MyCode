import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './cli.ts';
import { startUi } from './ui/server.ts';

const args = process.argv.slice(2);
if (args.some((a) => a !== '--ui' && a !== '--no-open')) {
  runCli(args);
} else {
  startUi({ open: !args.includes('--no-open') }).then(
    (address) => console.log(`Report Converter is running at ${address}\nLeave this window open while you use it; press Ctrl+C or use Quit in the page to stop.`),
    (err: Error) => {
      try {
        appendFileSync(join(tmpdir(), 'report-converter.log'), `${new Date().toISOString()} ${err.stack ?? err.message}\n`);
      } catch {
        void 0;
      }
      console.error(`Report Converter could not start: ${err.message}`);
      process.exitCode = 1;
    },
  );
}
