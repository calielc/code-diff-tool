// A stand-in for a custom AI command. It prints a plain text answer that shows what it received.
//   FAKE_CUSTOM_MODE=crash: stderr boom and exit 3
import { readFileSync } from 'node:fs'

if (process.env.FAKE_CUSTOM_MODE === 'crash') {
  process.stderr.write('boom')
  process.exit(3)
}
const args = process.argv.slice(2)
let stdin = ''
try {
  stdin = readFileSync(0, 'utf8')
} catch {
  /* no stdin */
}
process.stdout.write('ARGS ' + JSON.stringify(args) + '\n')
process.stdout.write('STDIN ' + JSON.stringify(stdin) + '\n')
process.stdout.write('Done.\n')
