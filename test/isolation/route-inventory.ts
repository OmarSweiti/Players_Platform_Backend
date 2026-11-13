// The isolation inventory (0.6.9; SR-NFR-SEC-003, TEST-003): every route the
// app serves, with the medical and scouting modules on, and what the
// two-tenant isolation suite does with it. A route missing from here fails
// the suite, so a new route cannot ship unexamined; an entry for a route the
// app no longer serves fails it too.
//
// A probe is a request that names another tenant's objects (`of`): the suite
// sends each with tenant B's objects as every role of tenant A. A smuggle
// pairs the caller's own object (`own`) with another tenant's — its own record
// moved to another tenant's player — and is sent by the member allowed to
// change the own object, so that only the other tenant's object can refuse
// it. Each probe and smuggle has a control: the same request naming A's own
// objects alone, by a member allowed to make it, succeeds.

/** One tenant's objects, as the suite seeds them: what a route can name. */
export interface Objects {
  /** A player with a medical record, a treatment session and two reports. */
  readonly player: string;
  /** A player nothing names yet: what a create names. */
  readonly bench: string;
  readonly record: string;
  /** A treatment session under the record, scheduled in the future. */
  readonly session: string;
  /** A draft scouting report by the scout. */
  readonly draft: string;
  /** A submitted scouting report by the scout. */
  readonly submitted: string;
  /** The scout's assignment, given by the sporting director. */
  readonly assignment: string;
  /** The scout: the member an assignment names. */
  readonly scout: string;
  /** An open invitation, sent by the owner. */
  readonly invitation: string;
  /** One of the scout's sign-in sessions. */
  readonly signIn: string;
  /** An open upload by the scout, for the player, its PDF arrived (0.8.3). */
  readonly upload: string;
  /** A file the scout uploaded for the player, scanned clean and promoted (0.8.4). */
  readonly file: string;
}

/** Who makes a control request: a member of the seeded tenant. */
export type Actor = 'owner' | 'director' | 'scout' | 'medic';

export interface Call {
  readonly path: string;
  readonly body?: Record<string, unknown>;
}

export type Probe = (of: Objects) => Call;
export type Smuggle = (of: Objects, own: Objects) => Call;

export type Entry =
  /** Names no tenant object: not called, and the reason recorded. */
  | { readonly kind: 'none'; readonly why: string }
  /**
   * Names an object, in its path or its body: another tenant's is not found
   * (`404`), or refused before it is looked for (`403`, a role without the
   * route's permission). The control, with the caller's own, succeeds.
   */
  | {
      readonly kind: 'object';
      readonly probes: readonly Probe[];
      readonly smuggles?: readonly Smuggle[];
      readonly control: Actor;
    }
  /**
   * A list, a count or a search: served, and never with another tenant's
   * rows, whatever it is asked to filter by. The control lists `shows`.
   */
  | {
      readonly kind: 'list';
      readonly probes: readonly Probe[];
      readonly control: Actor;
      readonly shows?: keyof Objects;
    }
  /**
   * The caller's own session: served to every member, never with another
   * tenant's data. `revokes`: it ends the session it is sent with.
   */
  | { readonly kind: 'own'; readonly probe: Probe; readonly revokes?: true };

const API = '/api/v1';
const at = (path: string): Call => ({ path: `${API}${path}` });
const sending = (path: string, body: Record<string, unknown>): Call => ({
  path: `${API}${path}`,
  body,
});

/** Every route, by `METHOD /path` as the app serves it. */
export const ROUTE_INVENTORY: Readonly<Record<string, Entry>> = {
  // ---- Health: no tenant, no data. ----
  'GET /health/live': { kind: 'none', why: 'a liveness probe: no tenant' },
  'GET /health/ready': { kind: 'none', why: 'a readiness probe: no tenant' },

  // ---- Sign-in (0.5.5–0.5.8). ----
  'GET /api/v1/auth/login': {
    kind: 'none',
    why: 'starts a sign-in at the identity provider: names no object',
  },
  'GET /api/v1/auth/callback': {
    kind: 'none',
    why: "the provider's answer to a sign-in this browser started: names no object",
  },
  'POST /api/v1/auth/backchannel-logout': {
    kind: 'none',
    why: "the provider's signed logout token: no tenant's session is named by an id",
  },
  'GET /api/v1/auth/step-up': {
    kind: 'none',
    why: "sends the caller's own session to the provider again: names no object",
  },
  'GET /api/v1/auth/session': { kind: 'own', probe: () => at('/auth/session') },
  'POST /api/v1/auth/logout': {
    kind: 'own',
    probe: () => at('/auth/logout'),
    revokes: true,
  },
  'POST /api/v1/auth/logout-all': {
    kind: 'own',
    probe: () => at('/auth/logout-all'),
    revokes: true,
  },
  'GET /api/v1/auth/sessions': {
    kind: 'list',
    probes: [() => at('/auth/sessions')],
    control: 'scout',
    shows: 'signIn',
  },
  'DELETE /api/v1/auth/sessions/:id': {
    kind: 'object',
    probes: [(of) => at(`/auth/sessions/${of.signIn}`)],
    control: 'scout',
  },

  // ---- Invitations (0.5.10). ----
  // ---- Uploads (0.8.3). ----
  'POST /api/v1/uploads': {
    kind: 'object',
    probes: [
      // An upload for another tenant's player.
      (of) =>
        sending('/uploads', {
          ownerKind: 'player-document',
          ownerId: of.player,
          fileName: 'contract.pdf',
          type: 'application/pdf',
          sizeBytes: 1024,
        }),
    ],
    control: 'scout',
  },
  'POST /api/v1/uploads/:id/complete': {
    kind: 'object',
    probes: [(of) => at(`/uploads/${of.upload}/complete`)],
    control: 'scout',
  },
  // ---- Downloads (0.8.5). ----
  'GET /api/v1/files/:id/download': {
    kind: 'object',
    probes: [(of) => at(`/files/${of.file}/download`)],
    control: 'scout',
  },

  'POST /api/v1/users/invitations': {
    kind: 'none',
    why: "an address and a role: names no object; the invitation is the caller's tenant's",
  },
  'GET /api/v1/users/invitations': {
    kind: 'list',
    probes: [() => at('/users/invitations')],
    control: 'owner',
    shows: 'invitation',
  },
  'DELETE /api/v1/users/invitations/:id': {
    kind: 'object',
    probes: [(of) => at(`/users/invitations/${of.invitation}`)],
    control: 'owner',
  },

  // ---- Medical records. ----
  'POST /api/v1/medical/records': {
    kind: 'object',
    probes: [
      (of) =>
        sending('/medical/records', {
          playerId: of.player,
          injuryType: 'Isolation probe',
        }),
    ],
    control: 'medic',
  },
  'GET /api/v1/medical/records': {
    kind: 'list',
    probes: [
      () => at('/medical/records'),
      (of) => at(`/medical/records?playerId=${of.player}`),
    ],
    control: 'medic',
    shows: 'record',
  },
  'GET /api/v1/medical/records/player/:playerId': {
    kind: 'object',
    probes: [(of) => at(`/medical/records/player/${of.player}`)],
    control: 'medic',
  },
  'GET /api/v1/medical/records/:id': {
    kind: 'object',
    probes: [(of) => at(`/medical/records/${of.record}`)],
    control: 'medic',
  },
  'PATCH /api/v1/medical/records/:id': {
    kind: 'object',
    probes: [
      (of) =>
        sending(`/medical/records/${of.record}`, { severity: 'Moderate' }),
    ],
    smuggles: [
      // The caller's own record, moved to another tenant's player.
      (of, own) =>
        sending(`/medical/records/${own.record}`, { playerId: of.player }),
    ],
    control: 'medic',
  },
  'DELETE /api/v1/medical/records/:id': {
    kind: 'object',
    probes: [(of) => at(`/medical/records/${of.record}`)],
    control: 'medic',
  },
  'GET /api/v1/medical/records/player/:playerId/active-injuries': {
    kind: 'object',
    probes: [
      (of) => at(`/medical/records/player/${of.player}/active-injuries`),
    ],
    control: 'medic',
  },
  'GET /api/v1/medical/records/player/:playerId/history': {
    kind: 'object',
    probes: [(of) => at(`/medical/records/player/${of.player}/history`)],
    control: 'medic',
  },

  // ---- Treatment sessions. ----
  'POST /api/v1/medical/sessions': {
    kind: 'object',
    probes: [
      (of) =>
        sending('/medical/sessions', {
          playerId: of.player,
          medicalRecordId: of.record,
          sessionDate: '2027-01-15T09:00:00Z',
          treatmentType: 'Isolation probe',
        }),
    ],
    smuggles: [
      // The caller's own player, under another tenant's record.
      (of, own) =>
        sending('/medical/sessions', {
          playerId: own.player,
          medicalRecordId: of.record,
          sessionDate: '2027-01-15T09:00:00Z',
          treatmentType: 'Isolation probe',
        }),
    ],
    control: 'medic',
  },
  'GET /api/v1/medical/sessions/player/:playerId': {
    kind: 'object',
    probes: [(of) => at(`/medical/sessions/player/${of.player}`)],
    control: 'medic',
  },
  'GET /api/v1/medical/sessions/:id': {
    kind: 'object',
    probes: [(of) => at(`/medical/sessions/${of.session}`)],
    control: 'medic',
  },
  'PATCH /api/v1/medical/sessions/:id': {
    kind: 'object',
    probes: [
      (of) =>
        sending(`/medical/sessions/${of.session}`, {
          treatmentType: 'Massage',
        }),
    ],
    smuggles: [
      // The caller's own session, moved under another tenant's player and record.
      (of, own) =>
        sending(`/medical/sessions/${own.session}`, {
          playerId: of.player,
          medicalRecordId: of.record,
        }),
    ],
    control: 'medic',
  },
  'PATCH /api/v1/medical/sessions/:id/status': {
    kind: 'object',
    probes: [
      (of) =>
        sending(`/medical/sessions/${of.session}/status`, {
          status: 'IN_PROGRESS',
        }),
    ],
    control: 'medic',
  },
  'DELETE /api/v1/medical/sessions/:id': {
    kind: 'object',
    probes: [(of) => at(`/medical/sessions/${of.session}`)],
    control: 'medic',
  },
  'GET /api/v1/medical/sessions/player/:playerId/upcoming': {
    kind: 'object',
    probes: [(of) => at(`/medical/sessions/player/${of.player}/upcoming`)],
    control: 'medic',
  },
  'GET /api/v1/medical/sessions/player/:playerId/stats': {
    kind: 'object',
    probes: [(of) => at(`/medical/sessions/player/${of.player}/stats`)],
    control: 'medic',
  },

  // ---- Scouting reports. ----
  'POST /api/v1/scouting/reports': {
    kind: 'object',
    probes: [(of) => sending('/scouting/reports', { playerId: of.bench })],
    control: 'scout',
  },
  'GET /api/v1/scouting/reports': {
    kind: 'list',
    probes: [
      () => at('/scouting/reports'),
      (of) => at(`/scouting/reports?playerId=${of.player}`),
      (of) => at(`/scouting/reports?scoutId=${of.scout}`),
    ],
    control: 'director',
    shows: 'submitted',
  },
  'GET /api/v1/scouting/reports/:id': {
    kind: 'object',
    probes: [(of) => at(`/scouting/reports/${of.submitted}`)],
    control: 'director',
  },
  'PATCH /api/v1/scouting/reports/:id': {
    kind: 'object',
    probes: [
      (of) => sending(`/scouting/reports/${of.draft}`, { strengths: 'Pace' }),
    ],
    smuggles: [
      // The caller's own draft, about another tenant's player.
      (of, own) =>
        sending(`/scouting/reports/${own.draft}`, { playerId: of.player }),
    ],
    control: 'scout',
  },
  'POST /api/v1/scouting/reports/:id/submit': {
    kind: 'object',
    probes: [(of) => at(`/scouting/reports/${of.draft}/submit`)],
    control: 'scout',
  },
  'POST /api/v1/scouting/reports/:id/approve': {
    kind: 'object',
    probes: [
      (of) =>
        sending(`/scouting/reports/${of.submitted}/approve`, {
          recommendation: 'MONITOR',
        }),
    ],
    control: 'director',
  },
  'POST /api/v1/scouting/reports/:id/reject': {
    kind: 'object',
    probes: [(of) => at(`/scouting/reports/${of.submitted}/reject`)],
    control: 'director',
  },
  'DELETE /api/v1/scouting/reports/:id': {
    kind: 'object',
    probes: [(of) => at(`/scouting/reports/${of.draft}`)],
    control: 'director',
  },
  'GET /api/v1/scouting/reports/stats/my-stats': {
    kind: 'list',
    probes: [() => at('/scouting/reports/stats/my-stats')],
    control: 'director',
  },

  // ---- Watchlist. ----
  'POST /api/v1/scouting/watchlist': {
    kind: 'object',
    probes: [(of) => sending('/scouting/watchlist', { playerId: of.bench })],
    control: 'scout',
  },
  'GET /api/v1/scouting/watchlist': {
    kind: 'list',
    probes: [() => at('/scouting/watchlist')],
    control: 'scout',
    shows: 'player',
  },
  'DELETE /api/v1/scouting/watchlist/:playerId': {
    kind: 'object',
    probes: [(of) => at(`/scouting/watchlist/${of.player}`)],
    control: 'scout',
  },
  'GET /api/v1/scouting/watchlist/check/:playerId': {
    kind: 'object',
    probes: [(of) => at(`/scouting/watchlist/check/${of.player}`)],
    control: 'scout',
  },

  // ---- Assignments. ----
  'POST /api/v1/scouting/assignments': {
    kind: 'object',
    probes: [
      (of) => sending('/scouting/assignments', { assignedToId: of.scout }),
    ],
    control: 'director',
  },
  'GET /api/v1/scouting/assignments/my-assignments': {
    kind: 'list',
    probes: [() => at('/scouting/assignments/my-assignments')],
    control: 'scout',
    shows: 'assignment',
  },
  'GET /api/v1/scouting/assignments/director-view': {
    kind: 'list',
    probes: [() => at('/scouting/assignments/director-view')],
    control: 'director',
    shows: 'assignment',
  },
  'PATCH /api/v1/scouting/assignments/:id': {
    kind: 'object',
    probes: [
      (of) =>
        sending(`/scouting/assignments/${of.assignment}`, { region: 'Gulf' }),
    ],
    smuggles: [
      // The caller's own assignment, given to another tenant's scout.
      (of, own) =>
        sending(`/scouting/assignments/${own.assignment}`, {
          assignedToId: of.scout,
        }),
    ],
    control: 'director',
  },
  'PATCH /api/v1/scouting/assignments/:id/status': {
    kind: 'object',
    probes: [
      (of) =>
        sending(`/scouting/assignments/${of.assignment}/status`, {
          status: 'IN_PROGRESS',
        }),
    ],
    control: 'scout',
  },
  'DELETE /api/v1/scouting/assignments/:id': {
    kind: 'object',
    probes: [(of) => at(`/scouting/assignments/${of.assignment}`)],
    control: 'director',
  },
};
