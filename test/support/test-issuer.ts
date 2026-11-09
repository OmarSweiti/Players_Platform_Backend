import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWK,
  type JWTPayload,
} from 'jose';

// An OpenID provider in the test's own process (0.5.4): discovery, keys, and a
// token endpoint that checks the client, the code, its redirect URI and PKCE.
// It signs what a test asks for, well-formed or hostile: another issuer or
// audience, a wrong nonce, an expired token, a key it never published, no
// signature at all. Realm behaviour is Keycloak's own (0.5.1); this proves
// what the API does with what an issuer sends. Every value is synthetic.
//
// It also serves the realm's events as Keycloak's admin API does (0.7.3): to
// the event reader's service account only, by its client-credentials token,
// newest first from `dateFrom`, paged by `first` and `max` — whatever events a
// test gives it, in Keycloak's own shape.

const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

interface SigningKey {
  readonly kid: string;
  readonly privateKey: CryptoKey;
  readonly publicJwk: JWK;
}

/** How the next ID token differs from a well-formed one. */
export interface Hostile {
  /** Claims to set; `undefined` removes the claim. */
  readonly claims?: Record<string, unknown>;
  /** `unpublished`: a key absent from the key set; `none`: no signature. */
  readonly signedWith?: 'current' | 'unpublished' | 'none';
  /** The `iss` the authorization response carries, if not this issuer. */
  readonly responseIssuer?: string;
}

interface Grant {
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly nonce?: string;
  readonly hostile: Hostile;
}

const base64url = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

async function newKey(): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', {
    extractable: true,
  });
  const kid = randomUUID();
  return {
    kid,
    privateKey,
    publicJwk: {
      ...(await exportJWK(publicKey)),
      kid,
      alg: 'RS256',
      use: 'sig',
    },
  };
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** The realm's events as the admin API answers with them: Keycloak's shape. */
export interface StoredEvents {
  login: Array<Record<string, unknown> & { time: number }>;
  admin: Array<Record<string, unknown> & { time: number }>;
}

export class TestIssuer {
  readonly clientId = 'sadara-api';
  readonly clientSecret = 'test-issuer-client-secret';
  /** The event reader's service account (0.7.3). */
  readonly eventReaderId = 'sadara-events';
  readonly eventReaderSecret = 'test-issuer-event-reader-secret';
  /** The events the admin API serves; a test fills them. */
  readonly events: StoredEvents = { login: [], admin: [] };
  /** The admin API's event reads, as `kind?query`, so a test sees its paging. */
  readonly eventReads: string[] = [];
  readonly subject = randomUUID();
  readonly sid = randomUUID();
  /** Requests for the key set, so a test can see a refetch. */
  keySetFetches = 0;

  private published: SigningKey[] = [];
  private signing!: SigningKey;
  private unpublished!: SigningKey;
  private readonly grants = new Map<string, Grant>();
  private readonly readerTokens = new Set<string>();

  private constructor(
    private readonly server: Server,
    readonly issuer: string,
    private readonly advertisedIssuer: string,
  ) {}

  /**
   * A running issuer at http://127.0.0.1:<port>/realms/test. `advertise`
   * makes its discovery document name another issuer than its own URL.
   */
  static async start(advertise?: string): Promise<TestIssuer> {
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    const issuer = `http://127.0.0.1:${port}/realms/test`;
    const instance = new TestIssuer(server, issuer, advertise ?? issuer);
    instance.signing = await newKey();
    instance.unpublished = await newKey();
    instance.published = [instance.signing];
    server.on('request', (request, response) => {
      instance.handle(request).then(
        ({ status, json }) => {
          response.writeHead(status, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
          });
          response.end(JSON.stringify(json));
        },
        () => {
          response.writeHead(500);
          response.end();
        },
      );
    });
    return instance;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.closeAllConnections();
      this.server.close(() => resolve());
    });
  }

  /** A new key signs from now on; `retire` drops the old one from the set. */
  async rotateKeys({ retire = false } = {}): Promise<void> {
    const next = await newKey();
    this.published = retire ? [next] : [next, ...this.published];
    this.signing = next;
  }

  /**
   * The provider's half of a sign-in: it reads the authorization request the
   * API built, as the provider would, and answers with the callback URL the
   * browser brings back — the code, the state and this issuer's `iss`.
   */
  authorize(authorizationUrl: URL, hostile: Hostile = {}): URL {
    const query = authorizationUrl.searchParams;
    const expect = (name: string, value: string) => {
      if (query.get(name) !== value) {
        throw new Error(`the authorization request's ${name} is not ${value}`);
      }
    };
    expect('client_id', this.clientId);
    expect('response_type', 'code');
    expect('code_challenge_method', 'S256');
    const redirectUri = query.get('redirect_uri');
    const codeChallenge = query.get('code_challenge');
    if (!redirectUri || !codeChallenge) {
      throw new Error('the authorization request has no callback or challenge');
    }
    const code = randomBytes(16).toString('base64url');
    this.grants.set(code, {
      redirectUri,
      codeChallenge,
      nonce: query.get('nonce') ?? undefined,
      hostile,
    });
    const callback = new URL(redirectUri);
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', query.get('state') ?? '');
    callback.searchParams.set('iss', hostile.responseIssuer ?? this.issuer);
    return callback;
  }

  /** A back-channel logout token, well-formed unless `hostile` says otherwise. */
  logoutToken(hostile: Hostile = {}): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    return this.sign(
      {
        iss: this.issuer,
        aud: this.clientId,
        iat: now,
        exp: now + 120,
        jti: randomUUID(),
        sub: this.subject,
        sid: this.sid,
        events: { [LOGOUT_EVENT]: {} },
      },
      hostile,
    );
  }

  private async handle(
    request: IncomingMessage,
  ): Promise<{ status: number; json: unknown }> {
    const path = new URL(request.url ?? '/', this.issuer).pathname;
    const realm = new URL(this.issuer).pathname;
    if (path === `${realm}/.well-known/openid-configuration`) {
      return { status: 200, json: this.metadata() };
    }
    if (path === `${realm}/protocol/openid-connect/certs`) {
      this.keySetFetches += 1;
      return {
        status: 200,
        json: { keys: this.published.map((key) => key.publicJwk) },
      };
    }
    if (
      path === `${realm}/protocol/openid-connect/token` &&
      request.method === 'POST'
    ) {
      return this.token(new URLSearchParams(await body(request)), request);
    }
    const admin = `/admin${realm}`;
    if (
      (path === `${admin}/events` || path === `${admin}/admin-events`) &&
      request.method === 'GET'
    ) {
      return this.eventsFor(request, path.endsWith('/admin-events'));
    }
    return { status: 404, json: { error: 'not_found' } };
  }

  /** The admin API's events: the reader's token, `dateFrom`, newest first, paged. */
  private eventsFor(request: IncomingMessage, admin: boolean) {
    const bearer = request.headers.authorization?.replace(/^Bearer /, '');
    if (bearer === undefined || !this.readerTokens.has(bearer)) {
      return { status: bearer === undefined ? 401 : 403, json: {} };
    }
    const query = new URL(request.url ?? '/', this.issuer).searchParams;
    this.eventReads.push(`${admin ? 'admin' : 'login'}?${query.toString()}`);
    const from = Number(query.get('dateFrom') ?? 0);
    const first = Number(query.get('first') ?? 0);
    const max = Number(query.get('max') ?? 100);
    const events = (admin ? this.events.admin : this.events.login)
      .filter((event) => event.time >= from)
      .sort((x, y) => y.time - x.time);
    return { status: 200, json: events.slice(first, first + max) };
  }

  private metadata() {
    const endpoint = (name: string) =>
      `${this.issuer}/protocol/openid-connect/${name}`;
    return {
      issuer: this.advertisedIssuer,
      authorization_endpoint: endpoint('auth'),
      token_endpoint: endpoint('token'),
      jwks_uri: endpoint('certs'),
      end_session_endpoint: endpoint('logout'),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'client_credentials'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: [
        'client_secret_post',
        'client_secret_basic',
      ],
      authorization_response_iss_parameter_supported: true,
      backchannel_logout_supported: true,
      backchannel_logout_session_supported: true,
    };
  }

  /** The token endpoint: the client, then the code, its callback and PKCE. */
  private async token(form: URLSearchParams, request: IncomingMessage) {
    const refuse = (error: string, status = 400) => ({
      status,
      json: { error },
    });
    const basic = request.headers.authorization?.startsWith('Basic ')
      ? Buffer.from(request.headers.authorization.slice(6), 'base64')
          .toString('utf8')
          .split(':')
          .map(decodeURIComponent)
      : [form.get('client_id'), form.get('client_secret')];
    if (
      basic[0] === this.eventReaderId &&
      basic[1] === this.eventReaderSecret &&
      form.get('grant_type') === 'client_credentials'
    ) {
      const token = randomBytes(24).toString('base64url');
      this.readerTokens.add(token);
      return {
        status: 200,
        json: { access_token: token, token_type: 'Bearer', expires_in: 300 },
      };
    }
    if (basic[0] !== this.clientId || basic[1] !== this.clientSecret) {
      return refuse('invalid_client', 401);
    }
    if (form.get('grant_type') !== 'authorization_code') {
      return refuse('unsupported_grant_type');
    }
    const code = form.get('code') ?? '';
    const grant = this.grants.get(code);
    this.grants.delete(code); // a code is used once
    const verifier = form.get('code_verifier') ?? '';
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    if (
      grant === undefined ||
      form.get('redirect_uri') !== grant.redirectUri ||
      challenge !== grant.codeChallenge
    ) {
      return refuse('invalid_grant');
    }
    const now = Math.floor(Date.now() / 1000);
    const idToken = await this.sign(
      {
        iss: this.issuer,
        sub: this.subject,
        aud: this.clientId,
        azp: this.clientId,
        exp: now + 300,
        iat: now,
        auth_time: now - 5,
        nonce: grant.nonce,
        sid: this.sid,
        acr: '1',
        amr: ['pwd'],
        email: 'member@agency.test',
        email_verified: true,
      },
      grant.hostile,
    );
    return {
      status: 200,
      json: {
        access_token: randomBytes(24).toString('base64url'),
        token_type: 'Bearer',
        expires_in: 300,
        id_token: idToken,
      },
    };
  }

  private async sign(claims: JWTPayload, hostile: Hostile): Promise<string> {
    const payload: Record<string, unknown> = { ...claims };
    for (const [name, value] of Object.entries(hostile.claims ?? {})) {
      if (value === undefined) delete payload[name];
      else payload[name] = value;
    }
    if (hostile.signedWith === 'none') {
      return `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url(payload)}.`;
    }
    const key =
      hostile.signedWith === 'unpublished' ? this.unpublished : this.signing;
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'RS256', kid: key.kid, typ: 'JWT' })
      .sign(key.privateKey);
  }
}
