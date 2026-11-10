import { ContextDetails } from "@/components/ui/context-details";
import { competitorWebsiteSchema, type ContextSnapshot } from "@/domain/projects";
import { BrowserLocalDate } from "./browser-local-date";

type Sources = ContextSnapshot["competitors"][number]["sources"];

/** Retained citations are historical references, never verification of an edited claim. */
export function ConversationReferences({ sources, edited }: { sources: Sources | undefined; edited: boolean }) {
  if (!sources?.length) return null;
  return (
    <ContextDetails className="conversation-references" title={<>Saved references ({sources.length})</>}>
      {edited && <p>Check these saved references against your current entry.</p>}
      <ul>
        {sources.map((source, index) => (
          <li key={`${source.url}-${index}`}>
            {competitorWebsiteSchema.safeParse(source.url).success ? (
              <a href={source.url} target="_blank" rel="noopener noreferrer">
                {source.title}
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            ) : (
              <span>{source.title}</span>
            )}
            <BrowserLocalDate dateTime={source.retrievedAt} prefix="Retrieved " />
          </li>
        ))}
      </ul>
    </ContextDetails>
  );
}
