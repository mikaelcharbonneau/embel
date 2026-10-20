import { SettingsArtwork, type SettingsArtworkName } from "@/components/ui/settings-artwork";

export type SettingsAvailabilityItem = { title: string; description: string; icon?: SettingsArtworkName };

/** Static capability information, separate from loading or editable preferences. */
export function SettingsAvailability({ title, description, items }: {
  title: string;
  description: string;
  items: readonly SettingsAvailabilityItem[];
}) {
  return <section className="sg-card sg-availability" aria-label={title}>
    <header><h2>{title}</h2><span className="sg-badge">Not available yet</span></header>
    <p className="sg-availability-description">{description}</p>
    <details className="sg-availability-details">
      <summary>View unavailable features</summary>
      <dl>{items.map(item => <div key={item.title}>
        <dt>{item.icon && <span className="sg-availability-icon"><SettingsArtwork name={item.icon} /></span>}{item.title}</dt>
        <dd>{item.description}</dd>
      </div>)}</dl>
    </details>
  </section>;
}
