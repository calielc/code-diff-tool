// The rules for the people that review a change.

/** The people of a change that asked for a review, then the ones with a submitted review in the order of their first review. A pending review and the author do not count. */
export function mineReviewers(requested: string[], reviews: { user: string; state: string }[], author: string): string[] {
  const submitted = reviews.filter((r) => r.state !== 'PENDING' && r.user !== author).map((r) => r.user)
  return [...new Set([...requested, ...submitted])]
}
