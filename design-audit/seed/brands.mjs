// The design-audit seed's accounts and brands. Everything here is test data for the LOCAL
// development stack only. The stand-in AI (stand-in-ai.mjs) answers each brand from this file,
// and seed.mjs drives each brand through the real app up to its `stage`.
//
// Stages, in journey order (seed.mjs walks a brand until it reaches its stage):
//   competitors   brief sent; competitor research shown, nothing chosen yet
//   personality   Strategy done (competitors, audience, positioning); Personality question open
//   inspiration   Voice done (personality, name, slogan or skipped); Inspiration gallery open
//   logo          Inspiration chosen (likes and an upload); Logo step open, no concepts yet
//   concepts      six logo concepts drawn, none chosen
//   directions    logo chosen; three creative directions drawn, none chosen
//   complete      direction chosen; brand assets ready and the brand kit downloaded
//
// Showcase brands use real generated images (cached in showcase/<key>/ after the first run).
// Every other brand gets placeholder images clearly marked "TEST DATA".

/** Options are [label, description] pairs; the first one is shown as recommended. */
const brand = (value) => value;

export const BRANDS = [
  // --- audit-free --------------------------------------------------------------------------
  brand({
    key: "spokesmith",
    account: "free",
    stage: "competitors",
    name: "Spokesmith",
    brief:
      "A mobile bicycle repair service that comes to your home or office in Montreal with a fully equipped cargo-bike workshop. We fix flats, tune gears, true wheels and service e-bikes the same day, so commuters never have to carry a broken bike across town. We want to feel trustworthy and handy, never like a hipster boutique, and we would like to grow into Laval and the South Shore next year.",
    competitors: [
      ["Velo Express Mobile", "Same-day mobile tune-ups across the Plateau."],
      ["Atelier Roue Libre", "A workshop cooperative with weekend repair clinics."],
      ["FixMyRide", "App-based bike repair booking in large Canadian cities."],
    ],
  }),
  brand({
    key: "brightsmile",
    account: "free",
    stage: "personality",
    name: "Little Lighthouse Dental",
    brief:
      "A pediatric dental clinic in Halifax for children from birth to sixteen, with sensory-friendly rooms, weekend hours and dentists trained for anxious kids and children with autism. Parents should feel calm the moment they book, and kids should look forward to coming back.",
    competitors: [
      ["Harbour Kids Dentistry", "A long-established downtown pediatric practice."],
      ["Smile Studio for Kids", "A playful clinic chain with cartoon branding."],
      ["Bedford Family Dental", "A general practice that also sees children."],
    ],
    audiences: [
      ["Parents of anxious children", "Parents who dread the dentist on their child's behalf."],
      ["Families of autistic children", "Families who need sensory-friendly care."],
      ["Busy two-income households", "Parents who need weekend appointments."],
    ],
    positionings: [
      ["The calm first visit", "We make the first visit the easiest one."],
      ["Built around sensory needs", "Every room and routine is designed for sensitive kids."],
      ["Dentistry on your schedule", "Weekend and evening care for working families."],
    ],
  }),
  brand({
    key: "northernlights",
    account: "free",
    stage: "inspiration",
    skipSlogan: true,
    name: "Northern Lights Community Physiotherapy and Sports Rehabilitation Collective",
    brief:
      "A non-profit physiotherapy collective in Whitehorse, Yukon, run by six physiotherapists who share one clinic. We offer sports rehabilitation, post-surgery recovery, pelvic health and sliding-scale fees for people who cannot afford private care. Our patients range from trail runners and hockey players to seniors recovering from hip replacements, and many travel hours from small northern communities, so we also run video follow-ups and a lending library of exercise equipment. The name is long on purpose because the community chose it.",
    competitors: [
      ["Yukon Physio & Performance", "A private sports clinic with a performance focus."],
      ["Whitehorse General Rehab", "The hospital outpatient rehabilitation service."],
      ["Klondike Movement Clinic", "A massage and physiotherapy studio."],
    ],
    audiences: [
      ["Northern athletes", "Trail runners, skiers and hockey players."],
      ["Seniors after surgery", "Older adults recovering from joint replacements."],
      ["Remote community members", "People who travel hours for care."],
    ],
    positionings: [
      ["Care that belongs to the community", "A collective, not a chain."],
      ["Recovery without the price barrier", "Sliding-scale fees for everyone."],
      ["From the trail back to the trail", "Sports rehabilitation for northern lives."],
    ],
    personalities: [
      ["Warm and grounded", "Plainspoken, kind and steady."],
      ["Energetic and outdoorsy", "Active, encouraging and bold."],
      ["Calm and clinical", "Precise, quiet and reassuring."],
    ],
  }),
  brand({
    key: "berenice",
    account: "free",
    stage: "logo",
    name: "Fromagerie Bérénice Côté",
    brief:
      "Une fromagerie de quartier dans le Vieux-Québec qui vend des fromages fermiers du Québec, des produits du terroir et des plateaux pour les fêtes. A neighbourhood cheese shop in Old Quebec City selling farmstead Quebec cheeses, local preserves and party platters, with tastings every Saturday. Bilingual customers, many tourists in summer, loyal locals in winter.",
    competitors: [
      ["La Fromagerie du Marché", "A large market stall with imported cheeses."],
      ["Épicerie J.A. Moisan", "A historic grocer with a cheese counter."],
      ["Fromages d'ici", "An online shop for Quebec cheeses."],
    ],
    audiences: [
      ["Quebec City locals", "Neighbours who shop weekly."],
      ["Summer tourists", "Visitors looking for authentic local food."],
      ["Holiday hosts", "People ordering platters for parties."],
    ],
    positionings: [
      ["Le terroir, une meule à la fois", "Local cheeses with their farmers' stories."],
      ["The tasting counter of Old Quebec", "Try before you buy, every Saturday."],
      ["Platters that start the party", "Ready-made boards for every occasion."],
    ],
    personalities: [
      ["Chaleureuse et authentique", "Warm, local and generous."],
      ["Raffinée et précise", "Refined, knowledgeable and calm."],
      ["Gourmande et joyeuse", "Playful, indulgent and festive."],
    ],
    slogans: ["Le goût du terroir, à deux pas", "Fromages d'ici, gens d'ici", "Tasting Quebec, one wheel at a time"],
  }),
  brand({
    key: "quill",
    account: "free",
    stage: "concepts",
    name: "Quill",
    brief:
      "Simple contract templates and e-signatures for freelance designers and developers, with plain-language explanations of every clause.",
    competitors: [
      ["Bonsai", "All-in-one freelance business software."],
      ["HelloSign", "General-purpose e-signature tool."],
      ["Contract Club", "A template marketplace for creatives."],
    ],
    audiences: [
      ["Freelance designers", "Solo creatives who hate legal jargon."],
      ["Indie developers", "Contractors who need fast agreements."],
      ["Small studios", "Two-to-five person agencies."],
    ],
    positionings: [
      ["Contracts you can actually read", "Plain language first."],
      ["Signed before the call ends", "Fast templates and signatures."],
      ["Protection without a lawyer's bill", "Affordable peace of mind."],
    ],
    personalities: [
      ["Clear and confident", "Direct, modern and calm."],
      ["Friendly and witty", "Light, human and clever."],
      ["Serious and exact", "Formal, precise and trustworthy."],
    ],
    slogans: ["Contracts, minus the jargon", "Sign, send, start", "Write it down, get it done"],
  }),
  brand({
    key: "tidewater",
    account: "free",
    stage: "concepts",
    failedLogoSlots: 2,
    name: "Tidewater Kayak Tours",
    brief:
      "Guided sea kayak tours and sunset paddles around the islands of Tofino, British Columbia, for beginners and families, with gear rental and small groups of eight.",
    competitors: [
      ["Pacific Paddle Co", "Larger tour operator with motorboat support."],
      ["Clayoquot Kayaks", "Expert multi-day expeditions."],
      ["Surf Sister", "Surf school that also rents boards."],
    ],
    audiences: [
      ["Families on vacation", "Parents with children over eight."],
      ["First-time paddlers", "Adults who have never kayaked."],
      ["Couples", "Visitors looking for a sunset outing."],
    ],
    positionings: [
      ["Your first paddle, done right", "Patient guides for beginners."],
      ["Small groups, big coastline", "Never more than eight people."],
      ["Sunset on the water", "The evening tour Tofino is known for."],
    ],
    personalities: [
      ["Adventurous and welcoming", "Outdoorsy, friendly and safe."],
      ["Serene and natural", "Quiet, slow and scenic."],
      ["Bold and spirited", "Energetic and loud."],
    ],
    slogans: ["Paddle further, together", "The coast is calling", "Small boats, big water"],
  }),
  brand({
    key: "mosswood",
    account: "free",
    stage: "directions",
    name: "Mosswood Candles",
    brief:
      "Hand-poured soy candles scented like Pacific Northwest forests, sold online and at weekend craft markets in Portland, in refillable ceramic jars.",
    competitors: [
      ["Boy Smells", "Design-led candle brand with bold packaging."],
      ["Otherland", "Direct-to-consumer candles with seasonal drops."],
      ["Forest Floor Co", "Small-batch woodland candles."],
    ],
    audiences: [
      ["Eco-minded gift buyers", "People who prefer refillable products."],
      ["Craft market regulars", "Weekend shoppers who like makers."],
      ["Home decor lovers", "People styling cozy spaces."],
    ],
    positionings: [
      ["The forest, refilled", "Sustainable, refillable candles."],
      ["Made by hand in Portland", "Local craft you can meet."],
      ["Calm in a jar", "A slow ritual for busy evenings."],
    ],
    personalities: [
      ["Earthy and calm", "Natural, slow and warm."],
      ["Whimsical and cozy", "Storybook and soft."],
      ["Minimal and modern", "Clean, quiet and refined."],
    ],
    slogans: ["Light the forest", "Refill the calm", "Hand-poured in the woods"],
    palette: [
      ["#2F4A3A", "#C9A66B"],
      ["#4B3B2F", "#9DB5A0"],
      ["#1E2B2A", "#E3D5C1"],
    ],
  }),
  brand({
    key: "orchardlane",
    account: "free",
    stage: "complete",
    showcase: true,
    name: "Orchard Lane Cider",
    brief:
      "A family cidery in the Eastern Townships of Quebec making dry, small-batch craft ciders from heritage apple varieties grown on our own orchard, with a tasting room open on weekends and sales to restaurants and wine shops.",
    competitors: [
      ["Cidrerie Michel Jodoin", "A well-known Quebec cidery with sparkling ciders."],
      ["Domaine Lafrance", "Orchard and cidery with an agritourism focus."],
      ["Shacksbury", "A Vermont craft cider brand sold in cans."],
    ],
    audiences: [
      ["Food lovers on weekend trips", "Visitors touring the Eastern Townships."],
      ["Restaurant buyers", "Sommeliers looking for local dry ciders."],
      ["Craft drink enthusiasts", "People who enjoy natural wine and craft beer."],
    ],
    positionings: [
      ["Heritage apples, honest cider", "Old varieties, nothing added."],
      ["The orchard in every glass", "Grown, pressed and bottled on one farm."],
      ["Quebec's dry cider", "A drier, food-friendly alternative to sweet cider."],
    ],
    personalities: [
      ["Crafted and rustic", "Honest, warm and rooted in the land."],
      ["Elegant and understated", "Quiet confidence, like a good wine label."],
      ["Lively and bright", "Fresh, sparkling and social."],
    ],
    slogans: ["Grown here, pressed here", "Heritage apples, honest cider", "From our orchard to your table"],
    palette: [
      ["#3B4A2A", "#C8553D"],
      ["#7A2E2E", "#E8D9B5"],
      ["#1F3B4D", "#D9A441"],
    ],
    fonts: [
      ["Fraunces", "Manrope"],
      ["Lora", "Geist"],
      ["Manrope", "Lora"],
    ],
    directions: [
      "Rustic orchard heritage: deep leaf green with a ripe apple red, letterpress textures, hand-drawn apple branch line art; example uses on a bottle label, a wooden crate stamp and a tasting room chalkboard menu.",
      "Understated cellar elegance: oxblood and parchment, generous margins, a fine serif and small caps; example uses on a wine-shop shelf talker, a restaurant list card and a tissue-wrapped gift box.",
      "Bright Townships summer: lake blue and golden apple, bold geometric apple slices, playful patterns; example uses on a can, a farmers-market banner and an Instagram post.",
    ],
    refine: false,
  }),

  // --- audit-pro ---------------------------------------------------------------------------
  brand({
    key: "kestrel",
    account: "pro",
    stage: "complete",
    showcase: true,
    name: "Kestrel Analytics",
    brief:
      "A B2B analytics platform for mid-size logistics companies that turns fleet telematics, warehouse scans and delivery data into one live dashboard with delay predictions, so operations managers can fix late shipments before customers notice.",
    competitors: [
      ["Project44", "Supply chain visibility for large shippers."],
      ["FourKites", "Real-time freight tracking platform."],
      ["Samsara", "Connected operations and fleet telematics."],
    ],
    audiences: [
      ["Operations managers", "People accountable for on-time delivery."],
      ["Logistics directors", "Leaders choosing software for the whole fleet."],
      ["Customer success teams", "Teams fielding 'where is my order?' calls."],
    ],
    positionings: [
      ["See the delay before it happens", "Prediction, not just tracking."],
      ["One view of every shipment", "Fleet, warehouse and delivery in one place."],
      ["Analytics built for mid-size fleets", "Enterprise power without enterprise setup."],
    ],
    personalities: [
      ["Sharp and dependable", "Precise, fast and calm under pressure."],
      ["Bold and visionary", "Ambitious and forward-looking."],
      ["Friendly and approachable", "Plain-spoken and helpful."],
    ],
    slogans: ["See every mile", "Ahead of every delay", "Logistics, in focus"],
    palette: [
      ["#0F2A3D", "#F2A541"],
      ["#1B1B1F", "#3DDC97"],
      ["#2B2D6E", "#FF6B5B"],
    ],
    fonts: [
      ["Manrope", "Geist"],
      ["Geist", "Geist Mono"],
      ["Fraunces", "Manrope"],
    ],
    directions: [
      "Precision at altitude: deep navy and signal amber, a fine grid, flight-path lines and data points; example uses on a dashboard screen, a business card and a conference booth banner.",
      "Night operations: near-black with an electric green accent, monospaced data labels and bold route lines; example uses on a mobile app screen, a hoodie and a LinkedIn banner.",
      "Confident enterprise: indigo with a warm coral accent, large editorial serif headlines and soft shapes; example uses on a pitch deck slide, a whitepaper cover and an email header.",
    ],
    refine: true,
    refineInstruction: "Make the kestrel wing shape simpler and bolder so it reads at small sizes.",
  }),
  brand({
    key: "aurelie",
    account: "pro",
    stage: "complete",
    name: "Maison Aurélie",
    brief:
      "A wedding and event florist in Lyon creating garden-style bouquets and large installations with seasonal French flowers. We are an agency client: the founder wants a brand that feels romantic but professional for planners and venues.",
    competitors: [
      ["Fleurs de Saison", "A seasonal florist with a strong Instagram."],
      ["Atelier Pampa", "Dried-flower installations for events."],
      ["Monceau Fleurs", "A national florist chain."],
    ],
    audiences: [
      ["Engaged couples", "Couples planning a garden wedding."],
      ["Wedding planners", "Professionals who book florists for clients."],
      ["Venue managers", "Chateaux and estates hosting events."],
    ],
    positionings: [
      ["The garden, brought indoors", "Loose, seasonal arrangements."],
      ["Installations that make the room", "Large-scale floral design."],
      ["Lyon's planner-friendly florist", "Reliable, on time, on brief."],
    ],
    personalities: [
      ["Romantic and refined", "Soft, poetic and elegant."],
      ["Bold and artistic", "Expressive and dramatic."],
      ["Warm and dependable", "Friendly and organized."],
    ],
    slogans: ["Fleurs de saison, émotions de toujours", "Garden flowers, grand moments", "Bloom where you celebrate"],
    refine: true,
    refineInstruction: "Use a thinner, more elegant line for the flower stem.",
  }),
  brand({
    key: "brightharbor",
    account: "pro",
    stage: "complete",
    name: "Bright Harbor Learning",
    brief:
      "Online and in-person math and reading tutoring for kids aged 6 to 14 in Boston, with certified teachers, progress reports for parents and a free first session.",
    competitors: [
      ["Kumon", "Worksheet-based franchise tutoring."],
      ["Mathnasium", "Math-only learning centers."],
      ["Varsity Tutors", "Online tutoring marketplace."],
    ],
    audiences: [
      ["Parents of struggling readers", "Parents worried about reading level."],
      ["Ambitious parents", "Families preparing for exams."],
      ["Homeschool families", "Parents who want structured support."],
    ],
    positionings: [
      ["Real teachers, real progress", "Certified teachers and clear reports."],
      ["Confidence first", "Kids who believe they can learn."],
      ["Tutoring that fits your week", "Online or in person, after school."],
    ],
    personalities: [
      ["Encouraging and bright", "Positive, warm and clear."],
      ["Smart and steady", "Calm, credible and structured."],
      ["Playful and curious", "Fun, energetic and creative."],
    ],
    slogans: ["Where confidence learns to read", "Bright minds, steady progress", "Every child, a little brighter"],
  }),
];

export const ACCOUNTS = [
  { key: "fresh", email: "audit-fresh@example.test", plan: "free", purpose: "New free account with no brands" },
  { key: "free", email: "audit-free@example.test", plan: "free", purpose: "Free account at its credit limit" },
  { key: "pro", email: "audit-pro@example.test", plan: "pro", purpose: "Paid (test-mode) Pro account" },
];

export const STAGES = ["competitors", "personality", "inspiration", "logo", "concepts", "directions", "complete"];
export const reached = (brandStage, stage) => STAGES.indexOf(brandStage) >= STAGES.indexOf(stage);
