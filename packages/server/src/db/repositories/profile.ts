import type { Database as DatabaseType } from 'better-sqlite3';
import { ConflictError, type Profile, type ProfileInput } from '@vina/shared';

interface ProfileRow {
  id: 'me';
  full_name: string;
  email: string;
  phone: string | null;
  location: string | null;
  linkedin_url: string | null;
  website_url: string | null;
  bio: string | null;
  created_at: string;
  updated_at: string;
}

function rowToProfile(row: ProfileRow): Profile {
  return row;
}

export function findProfile(db: DatabaseType): Profile | null {
  const row = db.prepare(`SELECT * FROM profile WHERE id = 'me'`).get() as ProfileRow | undefined;
  return row ? rowToProfile(row) : null;
}

export function insertProfile(db: DatabaseType, input: ProfileInput): Profile {
  const existing = db.prepare(`SELECT id FROM profile WHERE id = 'me'`).get();
  if (existing) {
    throw new ConflictError('Profile already exists');
  }

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO profile
       (id, full_name, email, phone, location, linkedin_url, website_url, bio, created_at, updated_at)
     VALUES ('me', @full_name, @email, @phone, @location, @linkedin_url, @website_url, @bio, @created_at, @updated_at)`,
  ).run({
    full_name: input.full_name,
    email: input.email,
    phone: input.phone ?? null,
    location: input.location ?? null,
    linkedin_url: input.linkedin_url ?? null,
    website_url: input.website_url ?? null,
    bio: input.bio ?? null,
    created_at: now,
    updated_at: now,
  });

  const row = findProfile(db);
  if (!row) throw new Error('insertProfile: row missing immediately after insert');
  return row;
}

export function updateProfile(db: DatabaseType, patch: Partial<ProfileInput>): Profile {
  const current = findProfile(db);
  if (!current) {
    throw new ConflictError('No profile to update — call insertProfile first');
  }

  const next: Profile = {
    ...current,
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    updated_at: new Date().toISOString(),
  };

  db.prepare(
    `UPDATE profile SET
       full_name=@full_name, email=@email, phone=@phone, location=@location,
       linkedin_url=@linkedin_url, website_url=@website_url, bio=@bio, updated_at=@updated_at
     WHERE id='me'`,
  ).run({
    full_name: next.full_name,
    email: next.email,
    phone: next.phone,
    location: next.location,
    linkedin_url: next.linkedin_url,
    website_url: next.website_url,
    bio: next.bio,
    updated_at: next.updated_at,
  });

  return next;
}
