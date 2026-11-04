import type { neon } from '@neondatabase/serverless';
import { createHash } from 'node:crypto';
import { canonicalBookKey } from './book-identity';
import { validateArtifactPath } from './artifact-locator';

export class ArtifactRegistryError extends Error {
  constructor(
    public readonly code: 'ARTIFACT_PATH_COLLISION' | 'ARTIFACT_IDENTITY_CONFLICT' | 'REPOSITORY_NOT_WRITABLE' | 'LABELED_BOOK_MISSING',
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
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

/** 既有 artifact 落位（identity_key 全局唯一下的同书绑定）。 */
export interface ArtifactBindingRow {
  repositoryId: number;
  branch: string;
  canonicalPath: string;
}

export interface FindArtifactBindingInput {
  /** 与 reserveArtifactPath 同一口径的全量 identity hash。 */
  identityKey: string;
  labeledBookId: number;
}

/**
 * 查同书的既有 artifact 落位（只读）。换源重下（清污）时发布决策据此回旧行的仓：
 * reserveArtifactPath 的 ON CONFLICT 只在 labeled_book_id/repository/branch/canonical_path
 * 四者与既有行一致时放行幂等更新；切仓后的装配期仓不满足 ⇒ 成功下载终态 failed。
 */
export async function findArtifactBinding(
  sql: ReturnType<typeof neon>,
  input: FindArtifactBindingInput,
): Promise<ArtifactBindingRow | null> {
  if (!input.identityKey || input.identityKey.includes('\0')
    || !Number.isSafeInteger(input.labeledBookId) || input.labeledBookId <= 0) throw new Error('INVALID_ARTIFACT_INPUT');
  const rows = await sql`
    SELECT repository_id, branch, canonical_path FROM book_artifacts
    WHERE identity_key = ${input.identityKey} AND labeled_book_id = ${input.labeledBookId}
    LIMIT 1` as { repository_id: number | string; branch: string; canonical_path: string }[];
  const row = rows[0];
  if (!row) return null;
  const repositoryId = Number(row.repository_id);
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0 || !row.branch || !row.canonical_path) {
    throw new Error('INVALID_ARTIFACT_BINDING_ROW');
  }
  return { repositoryId, branch: row.branch, canonicalPath: row.canonical_path };
}

/** relocate1105：既有落位的搬迁依据（主键 + 当前落位 + 已发布版的章/字，供「更差不晋升」比对）。 */
export interface RelocatableArtifact extends ArtifactBindingRow {
  artifactId: number;
  published: boolean;
  chaptersDone: number;
  chars: number;
  /** 搬迁目标仓/分支的同路径已被别的 artifact 行占用（跳过 reserve 后不先查，发布会先覆盖他书文件）。 */
  targetPathTaken: boolean;
}

export interface FindRelocatableArtifactInput extends FindArtifactBindingInput {
  target: { repositoryId: number; branch: string };
}

/**
 * relocate1105：与 findArtifactBinding 同口径（identity_key + 本书库记录）的只读查询，多带主键与已发布统计。
 * 旧行钉在已满的旧仓时，发布改写到决策仓、登记时原子搬迁该行（见 registerArtifact 的 relocate），
 * 不再撞 identity 唯一约束终态 failed。
 */
export async function findRelocatableArtifact(
  sql: ReturnType<typeof neon>,
  input: FindRelocatableArtifactInput,
): Promise<RelocatableArtifact | null> {
  if (!input.identityKey || input.identityKey.includes('\0')
    || !Number.isSafeInteger(input.labeledBookId) || input.labeledBookId <= 0
    || !Number.isSafeInteger(input.target?.repositoryId) || input.target.repositoryId <= 0
    || !input.target.branch) throw new Error('INVALID_ARTIFACT_INPUT');
  const rows = await sql`
    SELECT a.id, a.repository_id, a.branch, a.canonical_path, a.quality_status, a.chapters_done, a.chars,
      EXISTS (SELECT 1 FROM book_artifacts o WHERE o.repository_id = ${input.target.repositoryId}
        AND o.branch = ${input.target.branch} AND o.canonical_path = a.canonical_path AND o.id <> a.id) AS target_path_taken
    FROM book_artifacts a
    WHERE a.identity_key = ${input.identityKey} AND a.labeled_book_id = ${input.labeledBookId}
    LIMIT 1` as {
      id: number | string; repository_id: number | string; branch: string; canonical_path: string;
      quality_status: string; chapters_done: number | string; chars: number | string; target_path_taken: boolean;
    }[];
  const row = rows[0];
  if (!row) return null;
  const artifactId = Number(row.id);
  const repositoryId = Number(row.repository_id);
  const chaptersDone = Number(row.chapters_done);
  const chars = Number(row.chars);
  if (!Number.isSafeInteger(artifactId) || artifactId <= 0 || !Number.isSafeInteger(repositoryId) || repositoryId <= 0
    || !row.branch || !row.canonical_path || !Number.isSafeInteger(chaptersDone) || !Number.isSafeInteger(chars)) {
    throw new Error('INVALID_ARTIFACT_BINDING_ROW');
  }
  return {
    artifactId, repositoryId, branch: row.branch, canonicalPath: row.canonical_path,
    published: row.quality_status === 'published', chaptersDone, chars,
    targetPathTaken: row.target_path_taken === true,
  };
}

/** 按 identity_key 查既有落位的全字段（不限 labeled_book_id）：发布预检判「注定冲突」用。 */
export interface ArtifactIdentityOwner {
  labeledBookId: number;
  repositoryId: number;
  branch: string;
  canonicalPath: string;
}

/**
 * prepub1102：发布前预检的唯一查询。identity_key 唯一约束让每本书**只能有一条**落位，
 * 而 reserveArtifactPath 的 ON CONFLICT 只在与既有行四字段全等时放行。因此：
 * 既有行的 labeled_book_id ≠ 本次 book_id（重新入库/换书库记录）或 canonical_path ≠ 本次路径
 * （书名/作者口径变了）时，本次发布**必然**落 failed——与重下多少次、下完多少章无关。
 * findArtifactBinding 查的是「本书库记录 + 同身份」，这类情形它返回 null、不重定向，
 * 于是用户白等一整本下载才在发布阶段失败。本函数只读，判定留给调用方。
 */
export async function findArtifactIdentityOwner(
  sql: ReturnType<typeof neon>,
  input: { identityKey: string },
): Promise<ArtifactIdentityOwner | null> {
  if (!input.identityKey || input.identityKey.includes('\0')) throw new Error('INVALID_ARTIFACT_INPUT');
  const rows = await sql`
    SELECT labeled_book_id, repository_id, branch, canonical_path FROM book_artifacts
    WHERE identity_key = ${input.identityKey}
    LIMIT 1` as { labeled_book_id: number | string; repository_id: number | string; branch: string; canonical_path: string }[];
  const row = rows[0];
  if (!row) return null;
  const labeledBookId = Number(row.labeled_book_id);
  const repositoryId = Number(row.repository_id);
  if (!Number.isSafeInteger(labeledBookId) || labeledBookId <= 0
    || !Number.isSafeInteger(repositoryId) || repositoryId <= 0 || !row.branch || !row.canonical_path) {
    throw new Error('INVALID_ARTIFACT_BINDING_ROW');
  }
  return { labeledBookId, repositoryId, branch: row.branch, canonicalPath: row.canonical_path };
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
    // The task's book_id is outside the labeled_books id space (t8fk-41: row ordinals enqueued as
    // book_id). The worker stores error.message on the task, so name the cause instead of raw PG text.
    if (error && typeof error === 'object' && 'code' in error && error.code === '23503'
      && 'constraint' in error && error.constraint === 'book_artifacts_labeled_book_id_fkey') {
      throw new ArtifactRegistryError('LABELED_BOOK_MISSING',
        `labeled_books id=${input.labeledBookId} 不存在（download_tasks.book_id 不在书库 ID 空间）`);
    }
    throw error;
  }
}
