'use strict';

const { createRemoteJWKSet, jwtVerify } = require('jose');

const HEADER = 'cf-access-jwt-assertion';

const REASONS = {
  MISSING: 'missing-access-assertion',
  MALFORMED: 'malformed-access-assertion',
  EXPIRED: 'expired-access-assertion',
  WRONG_AUDIENCE: 'wrong-access-audience',
  WRONG_ISSUER: 'wrong-access-issuer',
  INVALID: 'invalid-access-assertion'
};

function reasonFor(err) {
  const code = err && err.code;
  if (code === 'ERR_JWT_EXPIRED') return REASONS.EXPIRED;
  if (code === 'ERR_JWS_INVALID' || code === 'ERR_JWT_INVALID') return REASONS.MALFORMED;
  if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
    if (err.claim === 'aud') return REASONS.WRONG_AUDIENCE;
    if (err.claim === 'iss') return REASONS.WRONG_ISSUER;
    return REASONS.INVALID;
  }
  return REASONS.INVALID;
}

/**
 * Cloudflare Access verification. Every request carries a JWT that Access
 * signed, in the Cf-Access-Jwt-Assertion header; the public keys come from the
 * team's own certificates endpoint and the audience tag is the one Access shows
 * for the application. There is no other auth path into this service: no shared
 * secret, no API key, no allowlisted source address.
 *
 * A service-token request (which is what the hub's edge function sends) carries
 * `common_name` rather than `email`, so the caller identity is read from
 * whichever of the two the assertion holds.
 */
class AccessVerifier {
  /**
   * @param {{teamDomain: string, audience: string, jwksCacheSeconds?: number,
   *          keySet?: Function}} options `keySet` is for tests, which use a
   *          local JWKS built from a fixture key and never touch the network.
   */
  constructor(options) {
    this.teamDomain = String(options.teamDomain).replace(/\/+$/, '');
    this.audience = options.audience;
    this.certsUrl = `${this.teamDomain}/cdn-cgi/access/certs`;
    this.keySet =
      options.keySet ||
      createRemoteJWKSet(new URL(this.certsUrl), {
        cacheMaxAge: (options.jwksCacheSeconds || 600) * 1000,
        cooldownDuration: 30000
      });
  }

  tokenFrom(headers) {
    const raw = headers ? headers[HEADER] : undefined;
    if (typeof raw !== 'string' || raw.trim().length === 0) return null;
    return raw.trim();
  }

  /**
   * @returns {Promise<{ok: true, identity: string, payload: object}
   *                  | {ok: false, reason: string}>}
   */
  async verify(headers) {
    const token = this.tokenFrom(headers);
    if (!token) return { ok: false, reason: REASONS.MISSING };
    try {
      const { payload } = await jwtVerify(token, this.keySet, {
        issuer: this.teamDomain,
        audience: this.audience
      });
      const identity =
        payload.email || payload.common_name || payload.sub || 'unknown';
      return { ok: true, identity: String(identity), payload };
    } catch (err) {
      return { ok: false, reason: reasonFor(err) };
    }
  }
}

module.exports = { AccessVerifier, HEADER, REASONS };
