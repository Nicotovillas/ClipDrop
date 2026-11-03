'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DownloadEngine, findExecutable, buildArguments, parseLine } = require('../src/engine.cjs');

const request = (destination, extras = {}) => ({ url: 'https://x.com/user/status/123', destination, ...extras });
const integration = { skip: process.platform === 'win32' ? 'Fake CLI uses a POSIX executable shebang; pure contract tests also run on Windows.' : false };

async function fixture(t, body) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ClipDropTest-'));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, 'fake-yt-dlp');
  const prelude = `#!${process.execPath}\n'use strict';\nconst fs=require('node:fs'); const path=require('node:path'); const root=${JSON.stringify(root)};\n`;
  await fs.promises.writeFile(executable, prelude + body, { mode: 0o700 });
  return { root, executable };
}

test('URL validation rejects arguments, control characters and unsupported protocols', () => {
  for (const url of ['--exec=bad', 'file:///etc/passwd', 'ftp://example.com/a', 'https://', 'https://x.com/a\n--exec=bad', 'https://x.com/space here']) {
    assert.throws(() => buildArguments(request(os.tmpdir(), { url })));
  }
  assert.throws(() => buildArguments(request('')));
  assert.throws(() => buildArguments(request(os.tmpdir(), { browser: 'chrome;touch pwned' })));
});

test('Arguments preserve URL and destination as separate literal values', () => {
  const url = 'https://x.com/user/status/123?a=$(touch%20PWN)&b=1;other';
  const destination = path.join(os.tmpdir(), 'carpeta con espacios');
  const args = buildArguments(request(destination, { url, browser: 'brave' }));
  assert.deepEqual(args.slice(-2), ['--', url]);
  assert.equal(args.filter((arg) => arg === url).length, 1);
  assert.equal(args[args.indexOf('--paths') + 1], destination);
  assert.equal(args[args.indexOf('--cookies-from-browser') + 1], 'brave');
  assert.ok(args.includes('--ignore-config'));
  assert.ok(args.includes('--no-overwrites'));
  assert.ok(args.includes('--no-cache-dir'));
});

test('Without ffmpeg only combined media is selected; ffmpeg enables merging', () => {
  const simple = buildArguments(request(os.tmpdir()));
  assert.equal(simple[simple.indexOf('--format') + 1], 'b[ext=mp4]/b');
  assert.ok(!simple.includes('--merge-output-format'));
  const merging = buildArguments(request(os.tmpdir()), '/tools/ffmpeg');
  assert.equal(merging[merging.indexOf('--ffmpeg-location') + 1], '/tools/ffmpeg');
  assert.ok(merging[merging.indexOf('--format') + 1].includes('+'));
});

test('Line parser handles finite progress, JSON paths with Unicode and malformed input', () => {
  assert.deepEqual(parseLine('CLIPDROP_PROGRESS: 42.5%\r'), { type: 'progress', value: 0.425 });
  assert.deepEqual(parseLine('CLIPDROP_PROGRESS:120%'), { type: 'progress', value: 1 });
  assert.deepEqual(parseLine('CLIPDROP_PROGRESS:-10%'), { type: 'progress', value: 0 });
  for (const value of ['NaN', 'NA', '', 'Infinity']) assert.equal(parseLine(`CLIPDROP_PROGRESS:${value}`), null);
  const filename = process.platform === 'win32' ? 'C:\\Videos\\Mañana [123].mp4' : '/Videos/Mañana [123].mp4';
  assert.deepEqual(parseLine(`CLIPDROP_FILE:${JSON.stringify(filename)}`), { type: 'file', path: filename });
  assert.equal(parseLine('CLIPDROP_FILE:{bad'), null);
  assert.equal(parseLine('CLIPDROP_FILE:123'), null);
  assert.deepEqual(parseLine('ERROR: unavailable'), { type: 'message', message: 'ERROR: unavailable' });
  assert.equal(findExecutable('../not-allowed'), null);
});

test('Fake CLI drains both pipes, preserves arguments and returns existing Unicode files', integration, async (t) => {
  const { root, executable } = await fixture(t, `
const output=path.join(root,'Mañana 🎬 [123].mp4');
fs.writeFileSync(output,'synthetic video fixture');
fs.writeFileSync(path.join(root,'args.json'),JSON.stringify(process.argv.slice(2)));
for(let i=0;i<3000;i++){ process.stdout.write('diagnostic '+i+'\\n'); process.stderr.write('stderr diagnostic '+i+'\\n'); }
process.stdout.write('CLIPDROP_PROGRESS:50%\\n');
process.stdout.write('CLIPDROP_FILE:'+JSON.stringify(output)+'\\n');
`);
  const engine = new DownloadEngine({ executable });
  const events = [];
  const url = 'https://x.com/user/status/123?a=$(touch%20PWN)&b=1';
  const files = await engine.download(request(root, { url }), (event) => events.push(event));
  assert.deepEqual(files, [await fs.promises.realpath(path.join(root, 'Mañana 🎬 [123].mp4'))]);
  const args = JSON.parse(await fs.promises.readFile(path.join(root, 'args.json'), 'utf8'));
  assert.deepEqual(args.slice(-2), ['--', url]);
  assert.ok(events.some((event) => event.type === 'progress' && event.value === 0.5));
  assert.equal(fs.existsSync(path.join(root, 'PWN')), false);
});

test('Nonzero exit includes stderr and an empty failure still has an explanation', integration, async (t) => {
  const { root, executable } = await fixture(t, `process.stderr.write('ERROR: fixture unavailable\\n'); process.exitCode=2;`);
  await assert.rejects(new DownloadEngine({ executable }).download(request(root)), /fixture unavailable/);
  await fs.promises.writeFile(executable, `#!${process.execPath}\nprocess.exit(7);\n`, { mode: 0o700 });
  await assert.rejects(new DownloadEngine({ executable }).download(request(root)), /código 7/);
});

test('Success without a file and malformed file markers fail clearly', integration, async (t) => {
  const { root, executable } = await fixture(t, `process.stdout.write('CLIPDROP_FILE:{bad\\n');`);
  await assert.rejects(new DownloadEngine({ executable }).download(request(root)), /sin devolver un archivo/);
});

test('Rejects reported files outside destination including symlink escapes', integration, async (t) => {
  const { root, executable } = await fixture(t, `
const file=path.join(root,'outside.mp4'); fs.writeFileSync(file,'fixture');
process.stdout.write('CLIPDROP_FILE:'+JSON.stringify(file)+'\\n');
`);
  const destination = path.join(root, 'destination');
  await assert.rejects(new DownloadEngine({ executable }).download(request(destination)), /fuera de la carpeta/);
  const link = path.join(destination, 'escape.mp4');
  await fs.promises.symlink(path.join(root, 'outside.mp4'), link);
  await fs.promises.writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(`CLIPDROP_FILE:${JSON.stringify(link)}\n`)});\n`, { mode: 0o700 });
  await assert.rejects(new DownloadEngine({ executable }).download(request(destination)), /fuera de la carpeta/);
});

test('Missing binary reports a useful execution error', integration, async (t) => {
  const { root } = await fixture(t, '');
  await assert.rejects(new DownloadEngine({ executable: path.join(root, 'missing') }).download(request(root)), /No se pudo ejecutar yt-dlp/);
});

test('Duplicate download is rejected; cancellation before spawn launches nothing', integration, async (t) => {
  const { root, executable } = await fixture(t, `fs.writeFileSync(path.join(root,'should-not-exist'),'bad');`);
  const engine = new DownloadEngine({ executable });
  const first = engine.download(request(root));
  // Register rejection immediately so no rejected promise is left unhandled.
  const cancelled = assert.rejects(first, { name: 'AbortError' });
  await assert.rejects(engine.download(request(root)), /Ya hay una descarga/);
  await engine.cancel();
  await cancelled;
  assert.equal(fs.existsSync(path.join(root, 'should-not-exist')), false);
  await engine.cancel(); // Idle cancellation does not poison the next request.
  await assert.rejects(engine.download(request(root)), /sin devolver un archivo/);
  assert.equal(fs.existsSync(path.join(root, 'should-not-exist')), true);
});

test('Cancellation stops parent and inherited child without removing existing files', integration, async (t) => {
  const { root, executable } = await fixture(t, `
const {spawn}=require('node:child_process');
const childBody="setTimeout(()=>require('node:fs').writeFileSync("+JSON.stringify(path.join(root,'child-survived'))+",'bad'),500);setTimeout(()=>{},20000);";
spawn(process.execPath,['-e',childBody],{stdio:'inherit'});
process.stdout.write('STARTED\\n');
setTimeout(()=>{},20000);
`);
  const keep = path.join(root, 'preserve.mp4');
  await fs.promises.writeFile(keep, 'existing');
  const engine = new DownloadEngine({ executable });
  const started = Date.now();
  await assert.rejects(engine.download(request(root), (event) => {
    if (event.type === 'message' && event.message === 'STARTED') void engine.cancel();
  }), { name: 'AbortError' });
  assert.ok(Date.now() - started < 5000, 'cancellation completed promptly');
  await new Promise((resolve) => setTimeout(resolve, 800));
  assert.equal(fs.existsSync(path.join(root, 'child-survived')), false);
  assert.equal(await fs.promises.readFile(keep, 'utf8'), 'existing');
});
