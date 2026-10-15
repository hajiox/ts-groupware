export type AttachmentSnapshot = { id: string; attachments: unknown[] | null }
type AttachmentPost = { id: string; attachments: unknown[] }

export function attachmentSignature(attachments: unknown): string {
  return JSON.stringify(Array.isArray(attachments) ? attachments : [])
}

export function loadedAttachmentSignatures(
  posts: AttachmentPost[], comments: Record<string, AttachmentPost[]>,
): Map<string, string> {
  return new Map([...posts, ...Object.values(comments).flat()]
    .map(post => [post.id, attachmentSignature(post.attachments)]))
}

export function attachmentIdBatches(ids: Iterable<string>): string[][] {
  const unique = [...new Set(ids)]
  const batches: string[][] = []
  for (let offset = 0; offset < unique.length; offset += 100) batches.push(unique.slice(offset, offset + 100))
  return batches
}

export function mergeAttachmentSnapshots<T extends AttachmentPost>(
  posts: T[], snapshots: Map<string, AttachmentSnapshot>, expected: Map<string, string>,
): T[] {
  let changed = false
  const next = posts.map(post => {
    const snapshot = snapshots.get(post.id)
    // A response started before a local save must not undo that save. Missing
    // IDs are not deletions, and no other post fields come from this endpoint.
    if (!snapshot || expected.get(post.id) !== attachmentSignature(post.attachments)
      || attachmentSignature(snapshot.attachments) === attachmentSignature(post.attachments)) return post
    changed = true
    return { ...post, attachments: snapshot.attachments || [] } as T
  })
  return changed ? next : posts
}
