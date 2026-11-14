/** What each step of the brand journey takes in credits, as the Plans page lists it. The server charges the
 * credits stored in fluid_private.generation_kinds; a test keeps this copy equal to the migrations. Credits only,
 * never money. */
export type StepCredits = {
  /** The step as the journey names it. */
  step: string;
  /** What one request of this step delivers. */
  delivers: string;
  /** The generation kind charged, or null for work that starts no paid request. */
  kind: string | null;
  credits: number;
  /** Counted once in a complete brand (every step done once). */
  inCompleteBrand: boolean;
  /** A step a complete brand can skip. */
  optional?: boolean;
};

export const STEP_CREDITS: readonly StepCredits[] = [
  {
    step: "Strategy · Competitors",
    delivers: "Competitor research for your idea",
    kind: "strategy.competitors",
    credits: 2,
    inCompleteBrand: true,
  },
  {
    step: "Strategy · Audience",
    delivers: "Audiences to choose from",
    kind: "strategy.audience",
    credits: 1,
    inCompleteBrand: true,
  },
  {
    step: "Strategy · Positioning",
    delivers: "Positionings to choose from",
    kind: "strategy.positioning",
    credits: 1,
    inCompleteBrand: true,
  },
  {
    step: "Voice · Personality",
    delivers: "Personalities to choose from",
    kind: "strategy.personality",
    credits: 1,
    inCompleteBrand: true,
  },
  { step: "Voice · Name", delivers: "A set of names", kind: "naming.generate", credits: 1, inCompleteBrand: true },
  {
    step: "Voice · Slogan (optional)",
    delivers: "A set of slogans",
    kind: "strategy.slogan",
    credits: 1,
    inCompleteBrand: true,
    optional: true,
  },
  {
    step: "Strategy and Voice",
    delivers: "An answer to a reply in your own words",
    kind: "strategy.reformulate",
    credits: 1,
    inCompleteBrand: false,
  },
  {
    step: "Identity · Inspiration",
    delivers: "Browsing, liking and adding your own references",
    kind: null,
    credits: 0,
    inCompleteBrand: false,
  },
  { step: "Identity · Logo", delivers: "Six logo concepts", kind: "logo.concepts", credits: 6, inCompleteBrand: true },
  {
    step: "Identity · Logo",
    delivers: "One change to a logo, described in your own words",
    kind: "logo.refine",
    credits: 1,
    inCompleteBrand: false,
  },
  {
    step: "Identity · Creative direction",
    delivers: "Three creative directions around your logo",
    kind: "identity.directions",
    credits: 6,
    inCompleteBrand: true,
  },
  {
    step: "Assets",
    delivers: "Brand images, brand guidelines, design system and every download",
    kind: null,
    credits: 0,
    inCompleteBrand: false,
  },
];

const sum = (rows: readonly StepCredits[]) => rows.reduce((total, row) => total + row.credits, 0);

/** Credits for a complete brand with every step done once, and without the optional steps. */
export const COMPLETE_BRAND_CREDITS = sum(STEP_CREDITS.filter((row) => row.inCompleteBrand));
export const COMPLETE_BRAND_CREDITS_REQUIRED = sum(STEP_CREDITS.filter((row) => row.inCompleteBrand && !row.optional));

/** How many complete brands a monthly allowance covers, rounded down. */
export function completeBrandsPerMonth(monthlyCredits: number) {
  return Math.max(0, Math.floor(monthlyCredits / COMPLETE_BRAND_CREDITS));
}
