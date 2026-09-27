import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseMHTML, transferDecode, decodeText} from '../lib/mime.js';
import {downloadURL, downloadFile, readLimited} from '../lib/download.js';
import {normalizeFragment, sameDocumentFragment, driveMessageURL} from '../lib/navigation.js';
import {documentPolicy} from '../lib/render.js';
const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const archive = new Uint8Array(readFileSync(new URL('../examples/example.mhtml', import.meta.url)));
const manifest = JSON.parse(read('manifest.json'));

test('MHTML preserves text and archived resources; rejects broken input', () => {
  const parsed = parseMHTML(archive);
  assert.match(parsed.html, /café · नमस्ते · 東京/);
  assert.equal(parsed.resources.get('cid:logo@example').type, 'image/svg+xml');
  assert.equal(parsed.resources.get('https://example.invalid/saved/assets/site.css').type, 'text/css');
  assert.equal(decodeText(transferDecode('caf=C3=A9=\r\n!', 'quoted-printable')), 'café!');
  assert.throws(() => parseMHTML(archive.subarray(0, archive.length - 60)), /incomplete/);
  assert.throws(() => transferDecode('%%%', 'base64'), /invalid base64/);
});
test('downloads use a fixed host and preserve account and resource key', () => {
  const url = new URL(downloadURL({id: 'ABCDEFGHIJK123', account: '1', resourceKey: '0-key'}));
  assert.equal(url.origin, 'https://drive.usercontent.google.com');
  assert.equal(url.searchParams.get('authuser'), '1');
  assert.equal(url.searchParams.get('resourcekey'), '0-key');
  assert.throws(() => downloadURL({id: '../bad'}), /Invalid/);
});
test('downloads reject unverified pages, wrong files, and other hosts', async () => {
  const target = {id: 'ABCDEFGHIJK123', names: ['chat.html']};
  await assert.rejects(downloadFile(target, async () => new Response('Sign in')), /verified file/);
  await assert.rejects(downloadFile(target, async () => new Response('Wrong file', {
    headers: {'content-disposition': 'attachment; filename="wrong.html"'}
  })), /does not match/);
  await assert.rejects(downloadFile(target, async () => ({url: 'https://other.invalid/file'})), /sign-in page/);
});
test('valid downloads use the browser session and retain the original bytes', async () => {
  const file = await downloadFile({id: 'ABCDEFGHIJK123', names: ['chat.html']}, async (_, options) => {
    assert.equal(options.credentials, 'include');
    assert.equal(options.cache, 'no-store');
    return new Response('<h1>Chat</h1>', {headers: {'content-disposition': 'attachment; filename="chat.html"'}});
  });
  assert.equal(decodeText(file.bytes), '<h1>Chat</h1>');
});
test('size limits apply to advertised and actual response size', async () => {
  await assert.rejects(readLimited(new Response('abcd', {headers: {'content-length': '4'}}), 3), /limit/);
  await assert.rejects(readLimited(new Response('abcd'), 3), /limit/);
});
test('message links keep file context and reject external navigation', () => {
  assert.equal(normalizeFragment('#café'), '#caf%C3%A9');
  assert.equal(normalizeFragment('javascript:alert(1)'), '');
  assert.equal(normalizeFragment('#' + 'x'.repeat(5000)), '');
  const bases = ['https://archive.invalid/chat.html'];
  assert.equal(sameDocumentFragment('chat.html#msg-1', bases), '#msg-1');
  assert.equal(sameDocumentFragment('https://other.invalid/chat.html#msg-1', bases), '');
  assert.equal(driveMessageURL({id: 'ABCDEFGHIJK123', account: '1', resourceKey: '0-key'}, '#msg-1'),
    'https://drive.google.com/file/d/ABCDEFGHIJK123/view?authuser=1&resourcekey=0-key#msg-1');
});
test('manifest keeps narrow permissions and both Drive frame resources', () => {
  assert.equal(manifest.version, JSON.parse(read('package.json')).version);
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.deepEqual(manifest.host_permissions, ['https://drive.google.com/*', 'https://drive.usercontent.google.com/*']);
  assert.deepEqual(manifest.web_accessible_resources, [{resources: ['viewer.html', 'sandbox.html'], matches: ['https://drive.google.com/*']}]);
});
test('document execution stays isolated from extension privileges', () => {
  assert.deepEqual(manifest.sandbox.pages, ['sandbox.html']);
  assert.match(manifest.content_security_policy.sandbox, /^sandbox allow-scripts;/);
  assert.doesNotMatch(manifest.content_security_policy.sandbox, /allow-same-origin|allow-forms|allow-popups|unsafe-eval/);
  assert.match(manifest.content_security_policy.extension_pages, /script-src 'self';/);
  assert.match(manifest.content_security_policy.extension_pages, /frame-src 'self';/);
  assert.match(read('viewer.html'), /sandbox="allow-scripts"/);
  assert.doesNotMatch(read('viewer.html'), /allow-same-origin/);
});
test('remote-script consent changes only the HTTPS script allowance', () => {
  for (const enabled of [false, true]) {
    const policy = documentPolicy(enabled), script = policy.split(';')[1];
    assert.equal(script.includes('https:'), enabled);
    assert.match(script, /'unsafe-inline' data: blob:/);
    assert.doesNotMatch(script, /(?:^| )http:|unsafe-eval/);
    for (const directive of ['connect-src', 'frame-src', 'worker-src', 'object-src', 'base-uri', 'form-action']) {
      assert.ok(policy.includes(directive + " 'none'"));
    }
  }
});
