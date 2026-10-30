// Folder-name rules shared by the two places that hand project files to the browser (the /p/ route in http.mjs and the
// Studio's picture thumbnails). The folders history/, review/ and checks/ hold the review file, undo history and check
// records; they are never served. File names are case-insensitive on Windows and default macOS (Review/ is review/), and
// NTFS has more spellings of the same folder (review::$INDEX_ALLOCATION, "review." and "review " with a trailing dot or
// space), so every comparison here is made on a lower-cased name and a name with those tricks is refused outright.

/** True for a path segment that names something by a trick: a ':' (drive letter, NTFS stream such as ::$INDEX_ALLOCATION) or a
 *  trailing dot or space (Windows drops those and opens the plain name). */
export function oddSegment(segment) {
  return segment.includes(':') || /[. ]$/.test(segment);
}

/** True when `segment` (the first folder of a path inside a project) is one of the hidden folders, in any letter case. */
export function isHiddenSegment(segment, hidden) {
  return Boolean(hidden) && hidden.has(String(segment).toLowerCase());
}
