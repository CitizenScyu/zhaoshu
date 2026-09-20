import type { neon } from '@neondatabase/serverless';
import { createHash } from 'node:crypto';
import { canonicalBookKey } from './book-identity';
import { validateArtifactPath } from './artifact-locator';

export class ArtifactRegistryError extends Error {
  constructor(public readonly code: 'ARTIFACT_PATH_COLLISION' | 'ARTIFACT_IDENTITY_CONFLICT' | 'REPOSITORY_NOT_WRITABLE') {
    super(code);
  }
}

export interface ReserveArtifactInput {
  labeledBookId: number;
  /** Stable database-safe identity, e.g. a full hash; do not pass canonicalBookKey's NUL delimiter. */
  identityKey: string;
  repositoryId: number;
  branch: string;
  canonicalPath: string;
}

/** Preserve the existing identity normalization while making its NUL separator safe for PostgreSQL text. */
export function artifactIdentityKey(title: string, author: string): string {
  return createHash('sha256').update(canonicalBookKey(title, author)).digest('hex');
}

/**
 * T3 pre-write seam. Persist the path claim BEFORE any GitHub PUT. Identity is unique
 * because this table holds one canonical location per book, not snapshot history.
 * Claims are never reassigned here; publication/lease checks belong to the publisher.
 */
export async function reserveArtifactPath(sql: ReturnType<typeof neon>, input: ReserveArtifactInput): Promise<number> {
  validateArtifactPath(input.canonicalPath);
  if (!input.identityKey || input.identityKey.includes('\0') || !input.branch
    || !Number.isSafeInteger(input.labeledBookId) || input.labeledBookId <= 0
    || !Number.isSafeInteger(input.repositoryId) || input.repositoryId <= 0) throw new Error('INVALID_ARTIFACT_INPUT');
  try {
    const rows = await sql`
      INSERT INTO book_artifacts (labeled_book_id, identity_key, repository_id, branch, canonical_path)
      SELECT ${input.labeledBookId}, ${input.identityKey}, id, ${input.branch}, ${input.canonicalPath}
      FROM storage_repositories
      WHERE id = ${input.repositoryId} AND branch = ${input.branch}
        AND enabled AND is_private AND NOT read_only AND sealed_at IS NULL
      ON CONFLICT (identity_key) DO UPDATE SET identity_key = EXCLUDED.identity_key
      WHERE book_artifacts.labeled_book_id = EXCLUDED.labeled_book_id
        AND book_artifacts.repository_id = EXCLUDED.repository_id
        AND book_artifacts.branch = EXCLUDED.branch
        AND book_artifacts.canonical_path = EXCLUDED.canonical_path
      RETURNING id` as { id: number | string }[];
    if (rows[0]) {
      const id = Number(rows[0].id);
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error('INVALID_ARTIFACT_ID');
      return id;
    }
    const repos = await sql`SELECT id FROM storage_repositories WHERE id = ${input.repositoryId}
      AND branch = ${input.branch} AND enabled AND is_private AND NOT read_only AND sealed_at IS NULL` as { id: number }[];
    throw new ArtifactRegistryError(repos.length ? 'ARTIFACT_IDENTITY_CONFLICT' : 'REPOSITORY_NOT_WRITABLE');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === '23505'
      && 'constraint' in error && error.constraint === 'book_artifacts_path_key') {
      throw new ArtifactRegistryError('ARTIFACT_PATH_COLLISION');
    }
    throw error;
  }
}
