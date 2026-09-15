import { bookFilenameCandidates, findBookFilename } from './book-file-name';

/** Resolve the same canonical/legacy protocol for downloads and online reading. */
export async function locateBookFile<T extends { name: string }>(
  listing: { files: T[]; truncated: boolean },
  title: string,
  author: string,
  lookupExact: (name: string) => Promise<T | null>,
): Promise<T | null> {
  for (const name of bookFilenameCandidates(title, author)) {
    const listed = listing.files.find(file => file.name === name);
    if (listed) return listed;
    // Check the preferred name even if a lower-priority legacy name is listed.
    const exact = await lookupExact(name);
    if (exact) return exact;
  }
  // A prefix appearing once in a truncated listing is not proof of uniqueness.
  if (listing.truncated) return null;
  const name = findBookFilename(listing.files.map(file => file.name), title, author);
  return listing.files.find(file => file.name === name) ?? null;
}
