import {
	IOT_HUB_TYPE_ORDER,
	getCategoryForItemType,
	type IotHubItemType,
	type ListingView,
} from '@models/iot-hub';

export interface GroupedSection {
	itemType: IotHubItemType;
	label: string;
	items: ListingView[];
	/** Rows of this type behind the response, before the four-row cap. */
	total: number;
	/** total - items.length, floored at 0. Zero means "no +N more link". */
	remaining: number;
	/** Type page for this section, already carrying the current query. */
	href: string;
}

export interface GroupedSectionOptions {
	query?: string;
	creatorId?: string;
}

/**
 * Turns one `grouped=true` response into the sections both surfaces render.
 *
 * `remaining` is computed from the rows STILL PRESENT, not from the
 * GROUPED_SECTION_SIZE the backend sent: rows published since the last deploy have
 * no static detail page and are filtered out by `getKnownSlugs()` before this runs.
 * Counting from the cap instead would leave a section showing three cards under a
 * header promising "+3 more" while `typeTotal` says seven exist — the two numbers on
 * screen have to add up to the one the header is quoting.
 *
 * A section whose rows were all dropped does not render at all — an empty section
 * under a populated header is worse than the section being absent.
 */
export function toGroupedSections(
	items: ListingView[],
	opts: GroupedSectionOptions = {}
): GroupedSection[] {
	const byType = new Map<IotHubItemType, ListingView[]>();
	const totals = new Map<IotHubItemType, number>();
	for (const item of items) {
		const cat = getCategoryForItemType(item.itemType);
		// A type the site has no category for (a backend type it doesn't surface)
		// cannot be laid out, so it is skipped rather than rendered headerless.
		if (!cat) continue;
		const type = cat.itemType;
		const list = byType.get(type) ?? [];
		list.push(item);
		byType.set(type, list);
		// Every row of a type carries the same typeTotal; the fallback keeps a
		// non-grouped response (typeTotal undefined) rendering as plain sections
		// with no "+N more".
		totals.set(type, item.typeTotal ?? list.length);
	}
	return toSections(
		[...byType].map(([itemType, sectionItems]) => ({
			itemType,
			items: sectionItems,
			total: totals.get(itemType) ?? sectionItems.length,
		})),
		opts
	);
}

/** One type's rows plus how many of that type exist behind them. */
export interface SectionGroup {
	itemType: IotHubItemType;
	items: ListingView[];
	/** Rows of this type in the whole answer, before the four-row cap. */
	total: number;
}

/**
 * Section order, labels, "+N more" arithmetic and header hrefs — the half of
 * grouping that does not care where the rows came from.
 *
 * `toGroupedSections` feeds it a runtime `grouped=true` response; the statically
 * built search page and creator profile feed it the content collections, where
 * each type's real total is known outright and no `typeTotal` exists to read.
 * Both paths must lay out identically, so neither gets to own this arithmetic.
 */
export function toSections(
	groups: ReadonlyArray<SectionGroup>,
	opts: GroupedSectionOptions = {}
): GroupedSection[] {
	const byType = new Map(groups.map((g) => [g.itemType, g]));
	return IOT_HUB_TYPE_ORDER.filter((type) => (byType.get(type)?.items.length ?? 0) > 0).map(
		(type) => {
			const group = byType.get(type)!;
			const total = Math.max(group.total, group.items.length);
			return {
				itemType: type,
				label: getCategoryForItemType(type)?.label ?? type,
				items: group.items,
				total,
				remaining: Math.max(0, total - group.items.length),
				href: sectionHref(type, opts),
			};
		}
	);
}

function sectionHref(type: IotHubItemType, opts: GroupedSectionOptions): string {
	const params = new URLSearchParams();
	const q = opts.query?.trim();
	if (q) params.set('q', q);
	// On a creator profile the section header must stay on the profile — "Widgets ›"
	// there means "this creator's widgets", not every widget in the Hub.
	if (opts.creatorId) {
		params.set('type', type);
		const qs = params.toString();
		return `/iot-hub/creator/${opts.creatorId}/${qs ? `?${qs}` : ''}`;
	}
	const slug = getCategoryForItemType(type)?.slug;
	if (!slug) return '#';
	const qs = params.toString();
	return `/iot-hub/${slug}/${qs ? `?${qs}` : ''}`;
}
