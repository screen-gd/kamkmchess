/**
 * Wire contracts for the public profile service (KHA-72).
 *
 * A public profile is a stable public identity. The contract is a closed
 * allowlist: the public identifier, the chosen name, the chosen avatar, and
 * the timestamps. There is no field for an account identifier, an email
 * address, a legal name, a session, or a credential, so a public payload
 * cannot carry the private sign-in identity even by accident.
 *
 * The parsers are the boundary. They reject an unknown field, a missing
 * field, and a value of the wrong shape, so a caller never reads a private
 * value out of a response it did not expect.
 */

/** The version of the public profile wire contract. */
export const PROFILE_SCHEMA_VERSION = 1;

/**
 * The bounded catalog of chosen avatars.
 *
 * A chosen avatar is a short key from this list. It is never a URL, a data
 * URI, an image blob, or a provider identifier.
 */
export const PROFILE_AVATAR_CHOICES = [
  'ember',
  'harbor',
  'meadow',
  'orchid',
  'slate',
  'sunrise',
  'tide',
  'violet',
] as const;

export type ProfileAvatarChoice = (typeof PROFILE_AVATAR_CHOICES)[number];

/** The origin of a public avatar. */
export type ProfileAvatarKind = 'generated' | 'chosen';

export interface ProfileAvatar {
  readonly kind: ProfileAvatarKind;
  /**
   * The generated avatar carries the profile identifier as its seed. A chosen
   * avatar carries a catalog key.
   */
  readonly value: string;
}

/** The public payload of one profile. */
export interface PublicProfile {
  readonly schemaVersion: number;
  readonly profileId: string;
  /** The chosen public name, or null while the owner has not chosen one. */
  readonly username: string | null;
  readonly avatar: ProfileAvatar;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One verified association between a guest seat and an account. */
export interface ProfileGuestLink {
  readonly schemaVersion: number;
  readonly linkId: string;
  readonly profileId: string;
  readonly matchId: string;
  readonly seat: 'white' | 'black';
  readonly linkedAt: string;
}

/** The signed-in account's own profile, with its linked guest seats. */
export interface OwnProfile extends PublicProfile {
  readonly guestLinks: readonly ProfileGuestLink[];
}

/** A freshly minted guest ownership proof. */
export interface GuestOwnershipProof {
  readonly schemaVersion: number;
  readonly proofId: string;
  /** The private proof secret. It is delivered once and never stored. */
  readonly secret: string;
  readonly matchId: string;
  readonly seat: 'white' | 'black';
  readonly expiresAt: string;
}

/** A change to the signed-in account's own profile. */
export interface ProfileUpdate {
  readonly username?: string | null;
  readonly avatar?: string;
}

/** A rejected public profile payload. */
export class ProfileContractError extends Error {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${path}: ${message}`);
    this.name = 'ProfileContractError';
    this.path = path;
  }
}

type JsonObject = Record<string, unknown>;

const PROFILE_ID_PATTERN = /^kp_[A-Za-z0-9_-]{8,63}$/;
const LINK_ID_PATTERN = /^kl_[A-Za-z0-9_-]{8,63}$/;
const PROOF_ID_PATTERN = /^kgp_[A-Za-z0-9_-]{8,63}$/;
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,22}[A-Za-z0-9]$/;

/**
 * The identifier shapes of the public profile contract.
 *
 * They are part of the contract, and the shared fixture in
 * `backend/profile/testdata/public-profile-contract.json` is the single
 * source of truth for them on both sides of the wire.
 */
export const PROFILE_CONTRACT_SHAPES = {
  profileIdPattern: PROFILE_ID_PATTERN.source,
  linkIdPattern: LINK_ID_PATTERN.source,
  proofIdPattern: PROOF_ID_PATTERN.source,
  usernamePattern: USERNAME_PATTERN.source,
} as const;

export function parsePublicProfile(value: unknown): PublicProfile {
  const path = 'publicProfile';
  const object = asObject(value, path);
  onlyKeys(object, ['schemaVersion', 'profileId', 'username', 'avatar', 'createdAt', 'updatedAt'], path);
  return readPublicProfileFields(object, path);
}

export function parseOwnProfile(value: unknown): OwnProfile {
  const path = 'ownProfile';
  const object = asObject(value, path);
  onlyKeys(object, ['schemaVersion', 'profileId', 'username', 'avatar', 'createdAt', 'updatedAt', 'guestLinks'], path);
  const base = readPublicProfileFields(object, path);
  if (!Array.isArray(object.guestLinks)) {
    throw new ProfileContractError('expected a list of linked guest seats', `${path}.guestLinks`);
  }
  const links = object.guestLinks.map((link, index) => parseGuestLink(link, `${path}.guestLinks[${index}]`));
  return { ...base, guestLinks: links };
}

/** Reads the allowlisted public fields of a profile object. */
function readPublicProfileFields(object: JsonObject, path: string): PublicProfile {
  requiredKeys(object, ['schemaVersion', 'profileId', 'username', 'avatar', 'createdAt', 'updatedAt'], path);
  if (object.schemaVersion !== PROFILE_SCHEMA_VERSION) {
    throw new ProfileContractError('unsupported schema version', `${path}.schemaVersion`);
  }
  const profileId = stringValue(object.profileId, `${path}.profileId`);
  if (!PROFILE_ID_PATTERN.test(profileId)) {
    throw new ProfileContractError('expected a public profile identifier', `${path}.profileId`);
  }
  const username = object.username === null ? null : stringValue(object.username, `${path}.username`);
  if (username !== null && !USERNAME_PATTERN.test(username)) {
    throw new ProfileContractError('expected a public name', `${path}.username`);
  }
  if (username !== null && (PROFILE_RESERVED_USERNAMES as readonly string[]).includes(username.toLowerCase())) {
    throw new ProfileContractError('expected a public name that is not reserved', `${path}.username`);
  }
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    profileId,
    username,
    avatar: parseAvatar(object.avatar, `${path}.avatar`),
    createdAt: timestampValue(object.createdAt, `${path}.createdAt`),
    updatedAt: timestampValue(object.updatedAt, `${path}.updatedAt`),
  };
}

export function parseGuestLink(value: unknown, path = 'guestLink'): ProfileGuestLink {
  const object = asObject(value, path);
  onlyKeys(object, ['schemaVersion', 'linkId', 'profileId', 'matchId', 'seat', 'linkedAt'], path);
  requiredKeys(object, ['schemaVersion', 'linkId', 'profileId', 'matchId', 'seat', 'linkedAt'], path);
  if (object.schemaVersion !== PROFILE_SCHEMA_VERSION) {
    throw new ProfileContractError('unsupported schema version', `${path}.schemaVersion`);
  }
  const linkId = stringValue(object.linkId, `${path}.linkId`);
  if (!LINK_ID_PATTERN.test(linkId)) {
    throw new ProfileContractError('expected a link identifier', `${path}.linkId`);
  }
  const profileId = stringValue(object.profileId, `${path}.profileId`);
  if (!PROFILE_ID_PATTERN.test(profileId)) {
    throw new ProfileContractError('expected a public profile identifier', `${path}.profileId`);
  }
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    linkId,
    profileId,
    matchId: stringValue(object.matchId, `${path}.matchId`),
    seat: seatValue(object.seat, `${path}.seat`),
    linkedAt: timestampValue(object.linkedAt, `${path}.linkedAt`),
  };
}

export function parseGuestOwnershipProof(value: unknown): GuestOwnershipProof {
  const path = 'guestOwnershipProof';
  const object = asObject(value, path);
  onlyKeys(object, ['schemaVersion', 'proofId', 'secret', 'matchId', 'seat', 'expiresAt'], path);
  requiredKeys(object, ['schemaVersion', 'proofId', 'secret', 'matchId', 'seat', 'expiresAt'], path);
  if (object.schemaVersion !== PROFILE_SCHEMA_VERSION) {
    throw new ProfileContractError('unsupported schema version', `${path}.schemaVersion`);
  }
  const proofId = stringValue(object.proofId, `${path}.proofId`);
  if (!PROOF_ID_PATTERN.test(proofId)) {
    throw new ProfileContractError('expected a proof identifier', `${path}.proofId`);
  }
  const secret = stringValue(object.secret, `${path}.secret`);
  if (secret.length < 16) {
    throw new ProfileContractError('expected a proof secret', `${path}.secret`);
  }
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    proofId,
    secret,
    matchId: stringValue(object.matchId, `${path}.matchId`),
    seat: seatValue(object.seat, `${path}.seat`),
    expiresAt: timestampValue(object.expiresAt, `${path}.expiresAt`),
  };
}

/**
 * Builds the request body of a profile update.
 *
 * The body never names a profile, an account, or an owner. The service takes
 * the account from the verified session, so a body that carried an identity
 * would be an attempt to act for somebody else.
 *
 * The name has three states on the wire. An absent name keeps the current
 * one. An empty name removes the chosen name and returns the profile to the
 * generated default. Any other name is the new chosen name.
 */
export function createProfileUpdateBody(update: ProfileUpdate): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (update.username !== undefined) body.username = update.username === null ? '' : update.username;
  if (update.avatar !== undefined) body.avatar = update.avatar;
  return body;
}

/**
 * Public names that would impersonate a participant label, an account role,
 * or a system identity.
 *
 * The service stays authoritative. This list mirrors the service rule so the
 * interface can answer before the request leaves.
 */
export const PROFILE_RESERVED_USERNAMES = [
  'guest',
  'guests',
  'anonymous',
  'deleted',
  'admin',
  'administrator',
  'system',
  'moderator',
  'support',
  'staff',
  'official',
  'root',
  'null',
  'undefined',
] as const;

/**
 * Reports whether a public name is reserved.
 *
 * A reserved name is refused because of what it says, not because of how it
 * is spelled, so the interface answers with its own sentence instead of the
 * shape guidance. The service stays authoritative; this check only lets the
 * interface answer before the request leaves.
 */
export function isReservedUsername(value: string): boolean {
  return (PROFILE_RESERVED_USERNAMES as readonly string[]).includes(value.trim().toLowerCase());
}

/**
 * Reports whether a public name is acceptable.
 *
 * The service stays authoritative. This check only lets the interface answer
 * before the request leaves.
 */
export function isAcceptableUsername(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 3 || trimmed.length > 24 || !USERNAME_PATTERN.test(trimmed)) return false;
  return !isReservedUsername(trimmed);
}

/**
 * Reports whether a chosen avatar is in the bounded catalog.
 */
export function isAcceptableAvatar(value: string): boolean {
  return value === '' || (PROFILE_AVATAR_CHOICES as readonly string[]).includes(value);
}

function parseAvatar(value: unknown, path: string): ProfileAvatar {
  const object = asObject(value, path);
  onlyKeys(object, ['kind', 'value'], path);
  requiredKeys(object, ['kind', 'value'], path);
  if (object.kind !== 'generated' && object.kind !== 'chosen') {
    throw new ProfileContractError('expected a generated or chosen avatar', `${path}.kind`);
  }
  const avatarValue = stringValue(object.value, `${path}.value`);
  if (object.kind === 'chosen' && !(PROFILE_AVATAR_CHOICES as readonly string[]).includes(avatarValue)) {
    throw new ProfileContractError('expected an avatar from the catalog', `${path}.value`);
  }
  return { kind: object.kind, value: avatarValue };
}

function asObject(value: unknown, path: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProfileContractError('expected an object', path);
  }
  return value as JsonObject;
}

function onlyKeys(value: JsonObject, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ProfileContractError(`unexpected field ${key}`, path);
    }
  }
}

function requiredKeys(value: JsonObject, keys: readonly string[], path: string): void {
  for (const key of keys) {
    if (!(key in value)) {
      throw new ProfileContractError(`missing field ${key}`, path);
    }
  }
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProfileContractError('expected a string', path);
  }
  return value;
}

function timestampValue(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (Number.isNaN(Date.parse(text))) {
    throw new ProfileContractError('expected a timestamp', path);
  }
  return text;
}

function seatValue(value: unknown, path: string): 'white' | 'black' {
  if (value === 'white' || value === 'black') return value;
  throw new ProfileContractError('expected white or black', path);
}
