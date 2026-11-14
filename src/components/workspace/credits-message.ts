/** The one way the app words when the monthly credits renew: "December 1". A credit period ends at midnight UTC,
 * so the day is read in UTC; the account menu, Plans, Settings and every step then name the same day. */
export function creditsRenewDate(periodEnd: string | null | undefined) {
  const renews = periodEnd ? new Date(periodEnd) : null;
  return renews && !Number.isNaN(renews.getTime())
    ? renews.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })
    : null;
}

/** Remaining credits matter only once they run out: say so, when they renew, and what is
 * kept. Never a price. */
export function creditsMessage(periodEnd: string | null, kept: string) {
  const date = creditsRenewDate(periodEnd);
  return `You've used this month's credits${date ? `. They renew on ${date}` : ""}. ${kept}`;
}
