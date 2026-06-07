import { nanoid } from 'nanoid';
import { db, now } from '../db.js';
import type {
  ImageProviderProfileInput,
  ImageProviderProfileWithSecret,
  SafeImageProviderProfile,
} from './types.js';
import {
  normalizeImageBaseUrl,
  normalizeImageCompatProfileId,
  normalizeImageModel,
  normalizeImageProfileName,
  normalizeOptionalApiKey,
  normalizeSupportsCountParameter,
} from './validation.js';

export interface ImageProviderProfileRepository {
  list(projectId: string): SafeImageProviderProfile[];
  get(profileId: string): ImageProviderProfileWithSecret | undefined;
  getActive(projectId: string): ImageProviderProfileWithSecret | undefined;
  create(projectId: string, input: ImageProviderProfileInput): SafeImageProviderProfile;
  update(projectId: string, profileId: string, input: ImageProviderProfileInput): SafeImageProviderProfile;
  activate(projectId: string, profileId: string): SafeImageProviderProfile;
  softDelete(projectId: string, profileId: string): SafeImageProviderProfile | undefined;
}

type ImageProviderProfileRow = Omit<
  ImageProviderProfileWithSecret,
  'active' | 'supports_count_parameter' | 'deleted_at'
> & {
  active: number;
  supports_count_parameter: number;
  deleted_at: number | null;
};

interface NormalizedImageProviderProfileInput {
  name: string;
  base_url: string;
  api_key: string | null;
  model: string;
  compat_profile_id: ImageProviderProfileWithSecret['compat_profile_id'];
  supports_count_parameter: 0 | 1;
}

function toFlag(value: number): 0 | 1 {
  return value === 1 ? 1 : 0;
}

function toProfile(row: ImageProviderProfileRow): ImageProviderProfileWithSecret {
  return {
    ...row,
    active: toFlag(row.active),
    supports_count_parameter: toFlag(row.supports_count_parameter),
  };
}

function toSafeProfile(profile: ImageProviderProfileWithSecret): SafeImageProviderProfile {
  return {
    id: profile.id,
    project_id: profile.project_id,
    name: profile.name,
    base_url: profile.base_url,
    model: profile.model,
    compat_profile_id: profile.compat_profile_id,
    supports_count_parameter: profile.supports_count_parameter,
    active: profile.active,
    has_api_key: profile.api_key.trim() ? 1 : 0,
    created_at: profile.created_at,
    updated_at: profile.updated_at,
    deleted_at: profile.deleted_at,
  };
}

function normalizeProfileInput(input: ImageProviderProfileInput): NormalizedImageProviderProfileInput {
  return {
    name: normalizeImageProfileName(input.name),
    base_url: normalizeImageBaseUrl(input.base_url),
    api_key: normalizeOptionalApiKey(input.api_key),
    model: normalizeImageModel(input.model),
    compat_profile_id: normalizeImageCompatProfileId(input.compat_profile_id),
    supports_count_parameter: normalizeSupportsCountParameter(input.supports_count_parameter),
  };
}

function getProfileById(profileId: string): ImageProviderProfileWithSecret | undefined {
  const row = db
    .prepare(
      `SELECT *
       FROM image_provider_profiles
       WHERE id = ?
         AND deleted_at IS NULL`,
    )
    .get(profileId) as ImageProviderProfileRow | undefined;
  return row ? toProfile(row) : undefined;
}

function getProfileForProject(projectId: string, profileId: string): ImageProviderProfileWithSecret | undefined {
  const row = db
    .prepare(
      `SELECT *
       FROM image_provider_profiles
       WHERE id = ?
         AND project_id = ?
         AND deleted_at IS NULL`,
    )
    .get(profileId, projectId) as ImageProviderProfileRow | undefined;
  return row ? toProfile(row) : undefined;
}

function assertUniqueProfileName(projectId: string, name: string, excludeProfileId?: string): void {
  const row = excludeProfileId
    ? db
        .prepare(
          `SELECT id
           FROM image_provider_profiles
           WHERE project_id = ?
             AND lower(name) = lower(?)
             AND id <> ?
             AND deleted_at IS NULL`,
        )
        .get(projectId, name, excludeProfileId)
    : db
        .prepare(
          `SELECT id
           FROM image_provider_profiles
           WHERE project_id = ?
             AND lower(name) = lower(?)
             AND deleted_at IS NULL`,
        )
        .get(projectId, name);

  if (row) throw new Error('provider profile name already exists');
}

function handleWriteError(error: unknown): never {
  if (error instanceof Error && error.message.includes('idx_image_provider_profiles_project_name')) {
    throw new Error('provider profile name already exists');
  }
  throw error;
}

const createProfile = db.transaction(
  (projectId: string, input: ImageProviderProfileInput): SafeImageProviderProfile => {
    const normalized = normalizeProfileInput(input);
    assertUniqueProfileName(projectId, normalized.name);

    const id = nanoid(12);
    const ts = now();
    db.prepare(
      `UPDATE image_provider_profiles
       SET active = 0, updated_at = ?
       WHERE project_id = ?
         AND deleted_at IS NULL`,
    ).run(ts, projectId);
    db.prepare(
      `INSERT INTO image_provider_profiles (
        id,
        project_id,
        name,
        base_url,
        api_key,
        model,
        compat_profile_id,
        supports_count_parameter,
        active,
        created_at,
        updated_at,
        deleted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
    ).run(
      id,
      projectId,
      normalized.name,
      normalized.base_url,
      normalized.api_key ?? '',
      normalized.model,
      normalized.compat_profile_id,
      normalized.supports_count_parameter,
      ts,
      ts,
    );

    const created = getProfileForProject(projectId, id);
    if (!created) throw new Error('provider profile not found');
    return toSafeProfile(created);
  },
);

const updateProfile = db.transaction(
  (projectId: string, profileId: string, input: ImageProviderProfileInput): SafeImageProviderProfile => {
    const current = getProfileForProject(projectId, profileId);
    if (!current) throw new Error('provider profile not found');

    const normalized = normalizeProfileInput(input);
    assertUniqueProfileName(projectId, normalized.name, profileId);
    const nextApiKey =
      normalized.api_key === null || normalized.api_key === '' ? current.api_key : normalized.api_key;
    const ts = now();

    db.prepare(
      `UPDATE image_provider_profiles
       SET name = ?,
           base_url = ?,
           api_key = ?,
           model = ?,
           compat_profile_id = ?,
           supports_count_parameter = ?,
           updated_at = ?
       WHERE id = ?
         AND project_id = ?
         AND deleted_at IS NULL`,
    ).run(
      normalized.name,
      normalized.base_url,
      nextApiKey,
      normalized.model,
      normalized.compat_profile_id,
      normalized.supports_count_parameter,
      ts,
      profileId,
      projectId,
    );

    const updated = getProfileForProject(projectId, profileId);
    if (!updated) throw new Error('provider profile not found');
    return toSafeProfile(updated);
  },
);

const activateProfile = db.transaction((projectId: string, profileId: string): SafeImageProviderProfile => {
  if (!getProfileForProject(projectId, profileId)) throw new Error('provider profile not found');

  const ts = now();
  db.prepare(
    `UPDATE image_provider_profiles
     SET active = 0, updated_at = ?
     WHERE project_id = ?
       AND deleted_at IS NULL`,
  ).run(ts, projectId);
  db.prepare(
    `UPDATE image_provider_profiles
     SET active = 1, updated_at = ?
     WHERE id = ?
       AND project_id = ?
       AND deleted_at IS NULL`,
  ).run(ts, profileId, projectId);

  const updated = getProfileForProject(projectId, profileId);
  if (!updated) throw new Error('provider profile not found');
  return toSafeProfile(updated);
});

const softDeleteProfile = db.transaction(
  (projectId: string, profileId: string): SafeImageProviderProfile | undefined => {
    const current = getProfileForProject(projectId, profileId);
    if (!current) return undefined;

    const ts = now();
    db.prepare(
      `UPDATE image_provider_profiles
       SET active = 0,
           deleted_at = ?,
           updated_at = ?
       WHERE id = ?
         AND project_id = ?
         AND deleted_at IS NULL`,
    ).run(ts, ts, profileId, projectId);

    return toSafeProfile({
      ...current,
      active: 0,
      updated_at: ts,
      deleted_at: ts,
    });
  },
);

export const imageProviderProfileRepo: ImageProviderProfileRepository = {
  list(projectId: string): SafeImageProviderProfile[] {
    const rows = db
      .prepare(
        `SELECT *
         FROM image_provider_profiles
         WHERE project_id = ?
           AND deleted_at IS NULL
         ORDER BY active DESC, updated_at DESC, created_at DESC, rowid DESC`,
      )
      .all(projectId) as ImageProviderProfileRow[];
    return rows.map((row) => toSafeProfile(toProfile(row)));
  },

  get(profileId: string): ImageProviderProfileWithSecret | undefined {
    return getProfileById(profileId);
  },

  getActive(projectId: string): ImageProviderProfileWithSecret | undefined {
    const row = db
      .prepare(
        `SELECT *
         FROM image_provider_profiles
         WHERE project_id = ?
           AND active = 1
           AND deleted_at IS NULL
         LIMIT 1`,
      )
      .get(projectId) as ImageProviderProfileRow | undefined;
    return row ? toProfile(row) : undefined;
  },

  create(projectId: string, input: ImageProviderProfileInput): SafeImageProviderProfile {
    try {
      return createProfile(projectId, input);
    } catch (error) {
      handleWriteError(error);
    }
  },

  update(projectId: string, profileId: string, input: ImageProviderProfileInput): SafeImageProviderProfile {
    try {
      return updateProfile(projectId, profileId, input);
    } catch (error) {
      handleWriteError(error);
    }
  },

  activate(projectId: string, profileId: string): SafeImageProviderProfile {
    return activateProfile(projectId, profileId);
  },

  softDelete(projectId: string, profileId: string): SafeImageProviderProfile | undefined {
    return softDeleteProfile(projectId, profileId);
  },
};
