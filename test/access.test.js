'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } = require('jose');
const { AccessVerifier, HEADER, REASONS } = require('../src/access');

const TEAM = 'https://conix-example.cloudflareaccess.com';
const AUD = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

/**
 * The fixture key is generated here and never committed. This repository is
 * public; a private key in the tree would be a private key on the internet even
 * if it only ever signed a test token.
 */
async function fixture() {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'test-key-1';
  jwk.alg = 'RS256';
  const keySet = createLocalJWKSet({ keys: [jwk] });
  const other = await generateKeyPair('RS256', { extractable: true });
  return { privateKey, keySet, otherPrivateKey: other.privateKey };
}

function signer(privateKey) {
  return async (claims, { expiresIn = '5m', issuer = TEAM, audience = AUD } = {}) => {
    let jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuedAt()
      .setIssuer(issuer)
      .setAudience(audience);
    if (expiresIn !== null) jwt = jwt.setExpirationTime(expiresIn);
    return jwt.sign(privateKey);
  };
}

const headers = (token) => (token === undefined ? {} : { [HEADER]: token });

test('the certificates URL is the team endpoint Cloudflare documents', () => {
  const verifier = new AccessVerifier({ teamDomain: `${TEAM}/`, audience: AUD, keySet: () => {} });
  assert.strictEqual(verifier.certsUrl, `${TEAM}/cdn-cgi/access/certs`);
});

test('a valid user assertion verifies and yields the email as the caller', async () => {
  const { privateKey, keySet } = await fixture();
  const sign = signer(privateKey);
  const verifier = new AccessVerifier({ teamDomain: TEAM, audience: AUD, keySet });
  const result = await verifier.verify(headers(await sign({ email: 'ans@example.test' })));
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.identity, 'ans@example.test');
});

test('a service-token assertion yields common_name as the caller', async () => {
  const { privateKey, keySet } = await fixture();
  const sign = signer(privateKey);
  const verifier = new AccessVerifier({ teamDomain: TEAM, audience: AUD, keySet });
  const result = await verifier.verify(headers(await sign({ common_name: 'hub-edge-function.access' })));
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.identity, 'hub-edge-function.access');
});

test('no header is refused', async () => {
  const { keySet } = await fixture();
  const verifier = new AccessVerifier({ teamDomain: TEAM, audience: AUD, keySet });
  const result = await verifier.verify(headers());
  assert.deepStrictEqual(result, { ok: false, reason: REASONS.MISSING });
});

test('an empty header is refused', async () => {
  const { keySet } = await fixture();
  const verifier = new AccessVerifier({ teamDomain: TEAM, audience: AUD, keySet });
  assert.strictEqual((await verifier.verify(headers('   '))).reason, REASONS.MISSING);
});

test('a token that is not a JWT is refused', async () => {
  const { keySet } = await fixture();
  const verifier = new AccessVerifier({ teamDomain: TEAM, audience: AUD, keySet });
  const result = await verifier.verify(headers('not.a.jwt'));
  assert.strictEqual(result.ok, false);
  assert.ok([REASONS.MALFORMED, REASONS.INVALID].includes(result.reason), result.reason);
});

test('a token signed by another key is refused', async () => {
  const { keySet, otherPrivateKey } = await fixture();
  const verifier = new AccessVerifier({ teamDomain: TEAM, audience: AUD, keySet });
  const token = await new SignJWT({ email: 'x@example.test' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setIssuedAt()
    .setIssuer(TEAM)
    .setAudience(AUD)
    .setExpirationTime('5m')
    .sign(otherPrivateKey);
  const result = await verifier.verify(headers(token));
  assert.strictEqual(result.ok, false);
});

test('an expired token is refused', async () => {
  const { privateKey, keySet } = await fixture();
  const verifier = new AccessVerifier({ teamDomain: TEAM, audience: AUD, keySet });
  const token = await new SignJWT({ email: 'x@example.test' })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
    .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
    .setIssuer(TEAM)
    .setAudience(AUD)
    .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
    .sign(privateKey);
  assert.strictEqual((await verifier.verify(headers(token))).reason, REASONS.EXPIRED);
});

test('a token for another Access application is refused', async () => {
  const { privateKey, keySet } = await fixture();
  const sign = signer(privateKey);
  const verifier = new AccessVerifier({ teamDomain: TEAM, audience: AUD, keySet });
  const token = await sign({ email: 'x@example.test' }, { audience: 'a-different-aud-tag' });
  assert.strictEqual((await verifier.verify(headers(token))).reason, REASONS.WRONG_AUDIENCE);
});

test('a token from another Cloudflare team is refused', async () => {
  const { privateKey, keySet } = await fixture();
  const sign = signer(privateKey);
  const verifier = new AccessVerifier({ teamDomain: TEAM, audience: AUD, keySet });
  const token = await sign({ email: 'x@example.test' }, { issuer: 'https://someone-else.cloudflareaccess.com' });
  assert.strictEqual((await verifier.verify(headers(token))).reason, REASONS.WRONG_ISSUER);
});

test('an unsigned "alg: none" token is refused', async () => {
  const { keySet } = await fixture();
  const verifier = new AccessVerifier({ teamDomain: TEAM, audience: AUD, keySet });
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = `${b64({ alg: 'none' })}.${b64({ email: 'x@example.test', iss: TEAM, aud: AUD })}.`;
  assert.strictEqual((await verifier.verify(headers(token))).ok, false);
});
