import type { Metadata } from "next";
import { legal } from "@/app/_brand/legal";
import { DocLink, DocumentPage, MailLink, type DocumentSection } from "@/components/legal/document-page";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "The terms that apply when you use Embel.",
};

const sections: DocumentSection[] = [
  {
    id: "agreement",
    title: "These terms",
    body: (
      <>
        <p>
          These Terms of Service are an agreement between you and {legal.operator} (“Embel”, “we”, “us”). They apply
          when you visit embel.xyz, create an account or use any part of the service. By creating an account or using
          Embel, you accept them. If you do not agree, do not use Embel.
        </p>
        <p>
          If you use Embel on behalf of a company or another organization, you confirm that you may accept these terms
          for it, and “you” includes that organization.
        </p>
      </>
    ),
  },
  {
    id: "service",
    title: "What Embel does",
    body: (
      <>
        <p>
          Embel helps you turn a product idea into a brand. It guides you through four steps: Strategy (competitors,
          audience and positioning), Voice (personality, name and an optional slogan), Identity (inspiration, logo and
          creative direction) and Assets (brand images, brand guidelines and a design system). Much of this work is
          produced with artificial intelligence (“AI”).
        </p>
        <p>
          We improve Embel continuously, so features may change, be added or be removed. We will try to give notice of
          changes that materially reduce what a paid plan includes.
        </p>
      </>
    ),
  },
  {
    id: "account",
    title: "Your account",
    body: (
      <>
        <p>
          You must be at least 18 years old, or the age of majority where you live if that is higher, to create an
          account. Give a valid email address and keep your password private. You are responsible for activity on your
          account. Tell us right away at <MailLink address={legal.contactEmail} /> if you think someone else has used
          it.
        </p>
        <p>One person may hold one free account. Creating accounts to obtain extra free credits is not allowed.</p>
      </>
    ),
  },
  {
    id: "plans",
    title: "Plans, credits and payment",
    body: (
      <>
        <p>
          Embel offers a Free plan and paid monthly plans. Each plan includes a number of credits every month, and each
          generation step uses credits. The <DocLink href="/plans">Plans</DocLink> page shows the current prices, the
          credits each plan includes and the credits each step uses. Credits have no cash value, cannot be transferred
          and do not carry over to the next month.
        </p>
        <p>
          When a generation fails or you stop it, the credits it used are returned, except for results it already
          delivered (for example, one credit for each image already made). Daily limits per account also apply, to keep
          the service available for everyone.
        </p>
        <p>
          Paid plans are sold through Stripe’s Link service, which acts as the merchant of record. Stripe processes the
          payment, adds any sales tax, VAT or GST that applies, sends receipts and invoices, and handles billing
          support. Its own terms also apply to the purchase. Prices are in US dollars.
        </p>
        <p>
          A paid plan renews automatically each month until you cancel it. You can cancel or change plans at any time
          from the Plans page or from Link. When you cancel, your plan stays active until the end of the period you
          already paid for, then your account returns to the Free plan. Except where the law requires otherwise,
          payments are not refunded for partial months or unused credits. If we change a plan’s price, the new price
          applies from your next renewal after we tell you about it, and you can cancel before then.
        </p>
      </>
    ),
  },
  {
    id: "your-content",
    title: "Your content and the results",
    body: (
      <>
        <p>
          “Your content” means what you give Embel, such as your product description, messages, answers, uploaded files
          and inspiration images. You keep all rights you have in it. You give us permission to store, process and
          transmit it only as needed to run Embel for you, including sending it to the service providers listed in our{" "}
          <DocLink href="/privacy">Privacy Policy</DocLink>. We do not use your content to train AI models.
        </p>
        <p>
          “Results” means what Embel produces for you, such as research summaries, names, slogans, logos, color
          palettes, images and brand guidelines. As between you and us, the results are yours: to the extent we have any
          rights in them, we assign those rights to you, and you may use them for any lawful purpose, including
          commercially. This applies on every plan, including Free.
        </p>
        <p>
          You confirm that you have the rights needed for everything you upload, and that your content does not infringe
          anyone else’s rights.
        </p>
      </>
    ),
  },
  {
    id: "ai-results",
    title: "Important limits of AI results",
    body: (
      <>
        <p>AI can be wrong, and similar requests can produce similar results for different people. In particular:</p>
        <ul>
          <li>
            Results may not be unique. Another person may receive a similar name, slogan or logo, and the law may not
            protect AI-generated work as it protects work made by a person.
          </li>
          <li>
            Embel does not provide legal clearance. Name, domain, social handle and trademark checks are quick automated
            lookups of a few sources at one moment. They can miss conflicts and do not reserve anything. Before you
            register, invest in or launch a brand, search the official trademark registers where you will operate, and
            consider asking a trademark lawyer.
          </li>
          <li>
            Competitor and market research comes from public web sources and can be incomplete or out of date. Check
            facts before you rely on them.
          </li>
          <li>Fonts linked from Embel are offered by their own providers, under their own licenses.</li>
        </ul>
        <p>You are responsible for how you use the results.</p>
      </>
    ),
  },
  {
    id: "acceptable-use",
    title: "Acceptable use",
    body: (
      <>
        <p>Do not use Embel to:</p>
        <ul>
          <li>break the law, or infringe anyone’s intellectual property, privacy or other rights;</li>
          <li>
            create content that is hateful, harassing, sexually explicit, violent, or deceptive, including brands that
            impersonate a real person or organization;
          </li>
          <li>
            upload malware, probe or overload the service, get around credit or rate limits, or access another person’s
            account or files;
          </li>
          <li>
            use automated means to access Embel, or resell or copy the service, except where we have agreed in writing.
          </li>
        </ul>
        <p>Our AI providers’ usage policies also apply to what you ask Embel to generate.</p>
      </>
    ),
  },
  {
    id: "ending",
    title: "Suspension and ending",
    body: (
      <>
        <p>
          You can stop using Embel at any time and delete your account from <DocLink href="/settings">Settings</DocLink>
          . Deleting your account also cancels a paid plan immediately.
        </p>
        <p>
          We may suspend or close an account that breaks these terms, puts the service or other people at risk, or must
          be closed by law. Where reasonable, we will tell you first and give you a chance to download your data. If we
          close an account without cause, or stop offering Embel, we will refund the unused part of a paid month.
        </p>
      </>
    ),
  },
  {
    id: "disclaimers",
    title: "Disclaimers",
    body: (
      <p>
        Embel is provided “as is” and “as available”. To the extent the law allows, we make no promises that it will
        always be available, error free or fit for a particular purpose, or that results will be accurate, unique or
        free of third-party rights. Keep your own copies of files that matter to you. Some places do not allow these
        exclusions, so they may not all apply to you.
      </p>
    ),
  },
  {
    id: "liability",
    title: "Limitation of liability",
    body: (
      <>
        <p>
          To the extent the law allows, we are not liable for indirect, incidental, special or consequential damages, or
          for lost profits, revenue, data or goodwill. Our total liability for any claim about Embel is limited to the
          greater of the amount you paid us in the 12 months before the claim and 50 US dollars.
        </p>
        <p>
          Nothing in these terms limits liability that cannot be limited by law, or rights you have as a consumer under
          the law where you live.
        </p>
      </>
    ),
  },
  {
    id: "changes",
    title: "Changes to these terms",
    body: (
      <p>
        We may update these terms as Embel changes. The date at the top shows the latest version. If a change is
        material, we will tell you by email or in the app before it takes effect. Continuing to use Embel after that
        means you accept the new terms; if you do not, you can cancel and delete your account.
      </p>
    ),
  },
  {
    id: "law",
    title: "Governing law",
    body: (
      <p>
        These terms are governed by {legal.governingLaw}. Disputes go to {legal.courts}, unless the law where you live
        as a consumer gives you the right to bring them elsewhere.
      </p>
    ),
  },
  {
    id: "contact",
    title: "Contact",
    body: (
      <p>
        Questions about these terms: <MailLink address={legal.contactEmail} />. For billing and receipts, you can also
        reach Stripe’s support through Link.
      </p>
    ),
  },
];

export default function TermsPage() {
  return (
    <DocumentPage
      title="Terms of Service"
      updated={legal.lastUpdated}
      intro={
        <p>
          The short version: you keep what you put in and what Embel makes for you. Credits renew monthly. AI results
          can be wrong or similar to someone else’s, and Embel’s name checks are not legal clearance.
        </p>
      }
      sections={sections}
    />
  );
}
