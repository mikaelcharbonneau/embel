/** Remaining credits matter only once they run out: say so, when they renew, and what is
 * kept. Never a price. */
export function creditsMessage(periodEnd: string | null, kept: string) {
  const renews = periodEnd ? new Date(periodEnd) : null;
  const date = renews && !Number.isNaN(renews.getTime()) ? renews.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" }) : null;
  return `You've used this month's credits${date ? `. They renew on ${date}` : ""}. ${kept}`;
}
