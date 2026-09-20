import type { neon } from '@neondatabase/serverless';

export interface ArtifactLocation {
  owner: string;
  repo: string;
  branch: string;
  canonical_path: string;
  blob_sha: string;
  bytes: number | string;
}

export function validateArtifactPath(path: string): void {
  if (!path || path.split('/').some(part => !part || part === '.' || part === '..')
    || /[\\\x00-\x1f\x7f]/.test(path)) throw new Error('INVALID_ARTIFACT_PATH');
}

export function artifactContentsUrl(location: ArtifactLocation): string {
  validateArtifactPath(location.canonical_path);
  if (![location.owner, location.repo].every(value => /^[\w.-]+$/.test(value) && value !== '.' && value !== '..')
    || !location.branch) throw new Error('INVALID_ARTIFACT_LOCATION');
  return `https://api.github.com/repos/${location.owner}/${location.repo}/contents/`
    + location.canonical_path.split('/').map(encodeURIComponent).join('/')
    + `?ref=${encodeURIComponent(location.branch)}`;
}

/** No artifact pointer means byte-for-byte legacy file protocol; never guess a new identity by filename. */
export async function locateTaskArtifact(
  sql: ReturnType<typeof neon>, artifactId?: number | string | null,
): Promise<ArtifactLocation | null> {
  if (artifactId == null) return null;
  if (!Number.isSafeInteger(Number(artifactId)) || Number(artifactId) <= 0) throw new Error('INVALID_ARTIFACT_ID');
  const rows = await sql`
    SELECT r.owner, r.repo, a.branch, a.canonical_path, a.blob_sha, a.bytes
    FROM book_artifacts a JOIN storage_repositories r ON r.id = a.repository_id
    WHERE a.id = ${Number(artifactId)} AND a.quality_status = 'published'` as ArtifactLocation[];
  // Disabled/sealed repositories still serve existing artifacts. A broken pointer must not
  // silently serve an unrelated legacy file; rollbacks retain this registry.
  if (!rows[0]) throw new Error('ARTIFACT_NOT_READABLE');
  artifactContentsUrl(rows[0]);
  return rows[0];
}
