import type { Metadata } from "next";
import { legal } from "@/app/_brand/legal";
import { DocLink, DocumentPage, MailLink, type DocumentSection } from "@/components/legal/document-page";

export const metadata: Metadata = {
  title: "Help",
  description: "How Embel works: the brand journey, credits and plans, downloads and your account.",
};

function Question({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="doc-page__question">
      <h3 className="doc-page__question-title">{title}</h3>
      {children}
    </div>
  );
}

const sections: DocumentSection[] = [
  {
    id: "start",
    title: "Getting started",
    body: (
      <>
        <Question title="How do I start a brand?">
          <p>
            On <DocLink href="/">Home</DocLink>, describe your product idea in a sentence or two and send it. Embel
            creates a project and starts researching competitors right away. You can try this before creating an
            account; your idea is kept while you sign up.
          </p>
        </Question>
        <Question title="Where are my brands?">
          <p>
            <DocLink href="/brands">Projects</DocLink> lists every brand you have started. Open one to continue where
            you left off. <DocLink href="/assets">Library</DocLink> collects the images and files your projects
            produced.
          </p>
        </Question>
        <Question title="Is my work saved?">
          <p>
            Yes. Changes save on their own, and the project bar shows Saved once they are stored. If a save fails, Embel
            keeps your edits and shows a way to try again.
          </p>
        </Question>
      </>
    ),
  },
  {
    id: "journey",
    title: "The brand journey",
    body: (
      <>
        <p>Every project moves through four steps. You can go back to an earlier step at any time.</p>
        <ol>
          <li>
            <strong>Strategy:</strong> who your competitors are, who your audience is and how you stand apart.
          </li>
          <li>
            <strong>Voice:</strong> your brand’s personality, its name and, if you want one, a slogan.
          </li>
          <li>
            <strong>Identity:</strong> pick inspiration, choose a logo concept, then choose one of three creative
            directions built around that exact logo, each with colors, typography and example uses.
          </li>
          <li>
            <strong>Assets:</strong> brand images, brand guidelines and a design system, ready to download.
          </li>
        </ol>
        <Question title="Can I stop a step that is running?">
          <p>
            Yes. Use Stop on the step, or open Activity from the account menu to see and stop everything that is
            running. Credits for results not yet delivered are returned.
          </p>
        </Question>
      </>
    ),
  },
  {
    id: "credits",
    title: "Credits and plans",
    body: (
      <>
        <Question title="What are credits?">
          <p>
            Each step that generates something uses credits. Your plan gives you a set number every month, and the
            account menu shows how many are left. The <DocLink href="/plans">Plans</DocLink> page lists how many credits
            each step uses.
          </p>
        </Question>
        <Question title="What happens if a step fails?">
          <p>
            The credits come back automatically. Only results that were actually delivered, such as images already made,
            keep their credits.
          </p>
        </Question>
        <Question title="What if I run out?">
          <p>
            New credits arrive on the date shown in the account menu. Unused credits do not carry over. To get more now,
            upgrade on the <DocLink href="/plans">Plans</DocLink> page.
          </p>
        </Question>
        <Question title="How do I change or cancel my plan?">
          <p>
            Go to <DocLink href="/plans">Plans</DocLink> and choose Switch or Cancel plan. A cancelled plan stays active
            until the end of the month you paid for. Payments, receipts and invoices are handled by Stripe through Link,
            where you can also manage your subscription.
          </p>
        </Question>
      </>
    ),
  },
  {
    id: "names",
    title: "Names, domains and trademarks",
    body: (
      <Question title="Does Embel check that a name is free to use?">
        <p>
          Embel runs quick automated checks on domains, social handles and some trademark registers, and links to
          official trademark searches. These checks can miss conflicts and do not reserve anything. Before you register
          or launch a name, search the trademark registers where you will operate and consider asking a trademark
          lawyer. See the <DocLink href="/terms#ai-results">Terms of Service</DocLink> for details.
        </p>
      </Question>
    ),
  },
  {
    id: "files",
    title: "Downloading your brand",
    body: (
      <Question title="What can I download?">
        <p>
          After you choose a creative direction, the brand board gives you logo files, the color palette, links to the
          fonts, social profile images, post templates and banners. Files you made also appear in{" "}
          <DocLink href="/assets">Library</DocLink>. The results are yours to use, including commercially.
        </p>
      </Question>
    ),
  },
  {
    id: "account",
    title: "Your account and data",
    body: (
      <>
        <Question title="I forgot my password.">
          <p>
            Choose Forgot password? on the <DocLink href="/sign-in">sign-in</DocLink> page and follow the link in the
            email. Check your spam folder if it does not arrive within a few minutes.
          </p>
        </Question>
        <Question title="How do I download or delete my data?">
          <p>
            In <DocLink href="/settings">Settings</DocLink> → Account → Your data, Download my data gives you a ZIP of
            your account. Delete account removes everything permanently and cancels a paid plan. Deleted projects can be
            restored from Projects until you delete your account. The <DocLink href="/privacy">Privacy Policy</DocLink>{" "}
            explains what we keep and why.
          </p>
        </Question>
      </>
    ),
  },
  {
    id: "contact",
    title: "Still need help?",
    body: (
      <p>
        Write to <MailLink address={legal.contactEmail} />. Tell us the project name and what you were doing, and
        include a screenshot if you can. Never send your password.
      </p>
    ),
  },
];

export default function HelpPage() {
  return (
    <DocumentPage
      title="Help"
      intro={<p>Answers to common questions about building a brand with Embel.</p>}
      sections={sections}
    />
  );
}
