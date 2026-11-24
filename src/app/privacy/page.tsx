import type { Metadata } from "next";
import { legal } from "@/app/_brand/legal";
import { DocLink, DocumentPage, MailLink, type DocumentSection } from "@/components/legal/document-page";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "What Embel collects, why, who processes it and how to download or delete it.",
};

const providers: { name: string; purpose: string }[] = [
  { name: "Supabase", purpose: "Account sign-in, the database and private file storage." },
  { name: "Vercel", purpose: "Hosting the app, running generation work, server logs and bot protection." },
  {
    name: "OpenAI",
    purpose:
      "Producing AI results, including web research for competitors. It receives the content each step needs. Under its API terms it does not use that content to train its models.",
  },
  {
    name: "Stripe (Link)",
    purpose:
      "Payments for paid plans, as merchant of record. Stripe collects your card details directly; we never see or store them.",
  },
  { name: "Resend", purpose: "Sending account emails, such as confirmation and password reset." },
  {
    name: "Cloudflare",
    purpose: "A security check (Turnstile) on sign-up and sign-in, when it is turned on.",
  },
  {
    name: "Domain, handle and trademark lookups",
    purpose:
      "When you check a name, the name (never your account details) is sent to domain registries and registrars such as Name.com, Vercel and Cloudflare, and, when available, to YouTube and the EU trademark office (EUIPO).",
  },
];

const sections: DocumentSection[] = [
  {
    id: "who",
    title: "Who we are",
    body: (
      <p>
        {legal.operator} (“Embel”, “we”) runs embel.xyz and is responsible for the personal information described here.
        For any privacy question or request, write to <MailLink address={legal.contactEmail} />.
      </p>
    ),
  },
  {
    id: "collect",
    title: "What we collect",
    body: (
      <>
        <ul>
          <li>
            <strong>Account details:</strong> your email address, a password (stored only as a secure hash by our
            sign-in provider), and the name and date preferences you add in Settings.
          </li>
          <li>
            <strong>Your projects:</strong> what you write and choose while building a brand, files and inspiration
            images you upload, and the results Embel makes for you.
          </li>
          <li>
            <strong>Plan and usage:</strong> your plan, your credit balance and history, and a record of each generation
            (its step, status, timing and cost to us). Stripe sends us your subscription status and an identifier for
            your Stripe customer record, not your card details.
          </li>
          <li>
            <strong>Technical data:</strong> sign-in cookies, and server logs with your IP address, browser type, the
            pages requested and errors. Security checks may look at signals from your browser to tell people from bots.
          </li>
        </ul>
        <p>
          We do not use advertising or analytics trackers, and we do not sell or rent personal information to anyone.
        </p>
      </>
    ),
  },
  {
    id: "use",
    title: "How we use it",
    body: (
      <ul>
        <li>To provide Embel: keep you signed in, save your projects and run the steps you start.</li>
        <li>To manage your plan and credits, and to keep accurate billing and accounting records.</li>
        <li>To keep the service secure and reliable: prevent abuse and fraud, enforce limits and fix problems.</li>
        <li>To send emails about your account, such as confirmations, password resets and important changes.</li>
        <li>To meet legal obligations.</li>
      </ul>
    ),
  },
  {
    id: "ai",
    title: "AI processing",
    body: (
      <p>
        When you start a step, the content it needs (for example your product description, earlier choices or a chosen
        logo) is sent to our AI provider to produce the result, and the result is stored in your account. We do not use
        your content to train AI models. Do not include sensitive personal information, such as health or financial
        details, in what you write or upload.
      </p>
    ),
  },
  {
    id: "providers",
    title: "Service providers",
    body: (
      <>
        <p>
          We share information only with providers that help us run Embel, and only what each one needs. They process it
          on our behalf under their own security and privacy commitments.
        </p>
        <dl className="doc-page__definitions">
          {providers.map((provider) => (
            <div key={provider.name}>
              <dt>{provider.name}</dt>
              <dd>{provider.purpose}</dd>
            </div>
          ))}
        </dl>
        <p>
          We may also disclose information when the law requires it, to protect people’s safety or our rights, or as
          part of a sale or reorganization of the business, in which case this policy continues to apply to it.
        </p>
      </>
    ),
  },
  {
    id: "where",
    title: "Where it is stored",
    body: (
      <p>
        Embel is run from Canada. Our providers store and process information in the United States and other countries,
        where the law may differ from the law where you live. We choose providers that protect it with encryption in
        transit, access controls and contractual commitments.
      </p>
    ),
  },
  {
    id: "retention",
    title: "How long we keep it",
    body: (
      <>
        <p>
          We keep your account and projects until you delete your account. Deleting a project moves it to Deleted
          projects, where you can restore it; its content stays in your account until the account is deleted. Deleting
          your account permanently removes your account, projects, files and history from Embel.
        </p>
        <p>
          After an account is deleted, we keep only an anonymous accounting record of credit and generation amounts,
          which is not linked to your email or your content. Stripe keeps its own payment records as the law requires.
          Server logs and backups roll off on their own within a limited period.
        </p>
      </>
    ),
  },
  {
    id: "choices",
    title: "Your choices and rights",
    body: (
      <>
        <ul>
          <li>
            <strong>See and download your data:</strong> Settings → Account → Your data → Download my data gives you a
            ZIP file with your account details, your project data and your files.
          </li>
          <li>
            <strong>Correct it:</strong> change your profile in <DocLink href="/settings">Settings</DocLink>, and edit
            your projects at any time.
          </li>
          <li>
            <strong>Delete it:</strong> delete your account, and everything in it, from Settings → Account → Your data.
          </li>
        </ul>
        <p>
          Depending on where you live, you may also have the right to ask what we hold about you, to object to or limit
          some uses, or to move your data. Write to <MailLink address={legal.contactEmail} /> and we will answer within
          30 days. You can also complain to your privacy regulator, such as the Office of the Privacy Commissioner of
          Canada or the Commission d’accès à l’information du Québec.
        </p>
      </>
    ),
  },
  {
    id: "cookies",
    title: "Cookies and browser storage",
    body: (
      <p>
        Embel uses essential cookies to keep you signed in and to protect sign-in and paid steps from bots. It also
        keeps unsaved drafts in your browser’s storage, so work in progress survives a reload. None of these are used
        for advertising or for tracking you across other sites, and Embel does not work without them.
      </p>
    ),
  },
  {
    id: "security",
    title: "Security",
    body: (
      <p>
        Your files are private to your account and served only to you. Connections are encrypted, and access to our
        systems is limited. No system is perfectly secure, so if we learn of a breach that affects you, we will tell you
        and the authorities as the law requires.
      </p>
    ),
  },
  {
    id: "children",
    title: "Children",
    body: <p>Embel is not meant for anyone under 18, and we do not knowingly collect their information.</p>,
  },
  {
    id: "changes",
    title: "Changes",
    body: (
      <p>
        We will update this policy when our practices change. The date at the top shows the latest version, and we will
        tell you about material changes by email or in the app before they take effect.
      </p>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <DocumentPage
      title="Privacy Policy"
      updated={legal.lastUpdated}
      intro={
        <p>
          We collect what Embel needs to build your brand and run your account, we never sell it, and you can download
          or delete everything from Settings at any time.
        </p>
      }
      sections={sections}
    />
  );
}
