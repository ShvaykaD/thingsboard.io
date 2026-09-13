import type { GroupedSection } from './iot-hub-grouping';

// Binder for a section shell cloned from <GroupedResultsPanel>'s
// [data-grouped-section-tmpl]. Same contract as bindListingCard /
// bindListingLink: the markup is authored once in an .astro component (so it
// carries Astro's scoped-style hash) and the runtime only fills the parts that
// vary. The grid of cards is appended by the caller, which owns the card
// templates and the per-row binder.
//
// Mirrors GroupedSection.astro 1:1 — the section's item type, the header href,
// the label and the "+N more" chip. Keep the two in step: a hook renamed on one
// side leaves the clone silently unfilled.
export function bindGroupedSection(root: HTMLElement, section: GroupedSection): void {
	root.setAttribute('data-item-type', section.itemType);

	const header = root.querySelector<HTMLAnchorElement>('[data-grouped-section-header]');
	if (header) header.setAttribute('href', section.href);

	const label = root.querySelector<HTMLElement>('[data-grouped-section-label]');
	if (label) label.textContent = section.label;

	const more = root.querySelector<HTMLElement>('[data-grouped-section-more]');
	if (more) {
		// Hidden rather than removed, so a re-render of the same clone source can
		// bring it back — and so the cloned shape stays identical to the built one.
		more.hidden = section.remaining === 0;
		more.textContent = `+${section.remaining} more`;
	}
}
