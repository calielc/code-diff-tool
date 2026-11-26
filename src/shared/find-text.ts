/** The start indexes of every match of `query` in `text`, ignoring case. Matches never overlap. An empty query has no match. */
export function findAll(text: string, query: string): number[] {
  if (query === '') return []
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()
  // Lower-casing can change the length of a few characters, and then the indexes no longer fit the text.
  if (haystack.length !== text.length) return []
  const starts: number[] = []
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) starts.push(at)
  return starts
}
