import {
	IOT_HUB_API_URL,
	IOT_HUB_STRINGS,
	SEARCH_PAGE_SIZE,
	DEFAULT_IOT_HUB_SORT_ID,
	getCardVariant,
	getCategoryForItemType,
	getIotHubSortOption,
	resolvePreviewImage,
	type ListingView,
	type PageData,
} from '@models/iot-hub';
import { bindListingCard } from './iot-hub-listing-card-bind';
import { bindGroupedSection } from './iot-hub-grouped-section-bind';
import { toGroupedSections } from './iot-hub-grouping';
import type { CardShape } from './listing-card-hooks';
import { getKnownSlugs } from './iot-hub-known-slugs';
import { updatePagination } from '@components/Pagination/pagination-client';
import { setPerPageValue } from '@components/Pagination/per-page-client';

// Host-visible "N results" line next to the pagination.
function updateResultsCount(countEl: HTMLElement, totalResults: number): void {
	const word =
		totalResults === 1
			? IOT_HUB_STRINGS.searchPage.resultSingular
			: IOT_HUB_STRINGS.searchPage.resultPlural;
	countEl.textContent = `${totalResults} ${word}`;
}

// Shared dynamic-search pipeline used by the search page, the creator
// page, the category pages, and any future surface that lists
// ListingViews with live filters. Discovers all wiring from data
// attributes on `[data-iot-hub-search-root]`:
//
//   * `data-creator-id`  — when set, every fetch adds &creatorId=<id> and
//                          cards render with the creator row hidden.
//   * `data-item-type`   — when set (category pages), every fetch adds
//                          &type=<itemType> so results stay scoped.
//   * `data-grouped`     — when present (/iot-hub/search/, creator profile),
//                          the surface asks for `grouped=true` and renders one
//                          section per item type instead of a flat page. See
//                          "Grouped surfaces" below.
//   * `data-page-size`   — initial page size; falls back to SEARCH_PAGE_SIZE.
//   * `data-base-path`   — root path used by `history.replaceState` when
//                          syncing URL state; falls back to `location.pathname`.
//
// Grouped surfaces: the response comes back already grouped and already capped
// per type, each row carrying `typeTotal`, so the client renders the sections it
// was given rather than slicing a flat page. Consequences, all of them
// deliberate:
//   * no `pageSize` is sent — the server sizes a grouped answer itself, and a
//     number here would be a second source of truth about its shape;
//   * there is no pagination, and no `page`/`pageSize` in the URL: the way to
//     more of one type is the section header;
//   * `?type=` narrows the surface to ONE type, which is not a grouped answer —
//     that state requests `grouped=false` and paginates like a category page.
//     Only a grouped surface with no pinned `data-item-type` reads it.
// Whether the page can render sections at all is a build-time fact (the section
// template and the card templates it clones are emitted by GroupedResultsPanel),
// which is why the switch is an attribute on the root rather than state.
//
// FilterPanel integration: when the page renders a FilterPanel, this
// pipeline listens for `iot-hub-filter:change` and adds the selected
// values to each fetch + URL state. Filter param names match the API:
//   panel section key → API/URL param
//   vendor            → vendors
//   hardwareType      → hardwareTypes
//   connectivity      → connectivity
//   category          → categories
//   useCase           → useCases
//   type              → widgetTypes / cfTypes / ruleChainTypes
//                       (resolved from `data-item-type`)
//
// Triggers (each clears + refetches):
//   * SearchFilterBar input change (300ms debounce) → resets page to 1
//   * IotHubSort selection change                   → resets page to 1
//   * Pagination items-per-page change              → resets page to 1
//   * Pagination page change                        → keeps page index
//
// URL state: q / sort / page / pageSize are mirrored in the query string
// via history.replaceState on every fetch. On load, any non-default value
// triggers an immediate fetch and is reflected in the matching UI control
// (SearchFilterBar input, IotHubSort selection, Pagination per-page).

const DEBOUNCE_MS = 300;

// FilterPanel section keys are translated to API/URL params here.
// `type` resolves to one of three names depending on the page's itemType
// (widgets / calculated fields / rule chains each have their own param).
const FILTER_KEY_TO_PARAM: Record<string, string> = {
	vendor: 'vendors',
	hardwareType: 'hardwareTypes',
	connectivity: 'connectivity',
	category: 'categories',
	useCase: 'useCases',
};

function filterParamName(filterKey: string, itemType: string): string {
	if (filterKey === 'type') {
		switch (itemType) {
			case 'WIDGET':
				return 'widgetTypes';
			case 'CALCULATED_FIELD':
				return 'cfTypes';
			case 'RULE_CHAIN':
				return 'ruleChainTypes';
			default:
				return 'types';
		}
	}
	return FILTER_KEY_TO_PARAM[filterKey] ?? filterKey;
}

// Reverse direction used when restoring from URL. The three `type` aliases
// all collapse back to the panel's `type` section key.
const PARAM_TO_FILTER_KEY: Record<string, string> = {
	vendors: 'vendor',
	hardwareTypes: 'hardwareType',
	connectivity: 'connectivity',
	categories: 'category',
	useCases: 'useCase',
	widgetTypes: 'type',
	cfTypes: 'type',
	ruleChainTypes: 'type',
};
const FILTER_PARAM_NAMES = Object.keys(PARAM_TO_FILTER_KEY);

function filtersEqual(
	a: Record<string, string[]>,
	b: Record<string, string[]>
): boolean {
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	if (aKeys.length !== bKeys.length) return false;
	for (const key of aKeys) {
		const av = a[key] ?? [];
		const bv = b[key] ?? [];
		if (av.length !== bv.length) return false;
		const aSet = new Set(av);
		for (const v of bv) if (!aSet.has(v)) return false;
	}
	return true;
}

export function setupDynamicSearch(): void {
	const root = document.querySelector<HTMLElement>('[data-iot-hub-search-root]');
	if (!root) return;
	if (root.dataset.dynamicSearchInited) return;
	root.dataset.dynamicSearchInited = 'true';

	const creatorId = root.dataset.creatorId ?? '';
	// The type this page is pinned to at build time (category pages). It decides
	// which card templates the page emits, so it must NOT be conflated with the
	// `?type=` a grouped surface can pick up at runtime: adopting that into
	// `itemType` would flip `mixedGrid` below and make the init guard demand a
	// `compact` template the page never rendered — killing dynamic search
	// outright. `typeFilter()` is the request-level union of the two.
	const itemType = root.dataset.itemType ?? '';
	const initialPageSize =
		Number.parseInt(root.dataset.pageSize ?? '', 10) || SEARCH_PAGE_SIZE;
	const basePath = root.dataset.basePath ?? location.pathname;
	// Hide the creator row on listing cards when scoped to a single creator
	// (all cards share that creator — the row would be repetitive).
	const showCreator = creatorId.length === 0;

	const input = root.querySelector<HTMLInputElement>('[data-search-input]');
	const resultsContainer = root.querySelector<HTMLElement>('[data-search-results]');
	const itemsWrap = root.querySelector<HTMLElement>('[data-search-items]');
	const paginationNav = root.querySelector<HTMLElement>('[data-tb-pagination]');
	// The bar wraps the nav + the items-per-page selector. Error/no-data states
	// hide the whole bar; a single page of results hides only the nav (via
	// updatePagination's hideOnSinglePage) so the per-page control stays usable.
	const paginationBar = root.querySelector<HTMLElement>('[data-tb-pagination-bar]');
	const countEl = root.querySelector<HTMLElement>('[data-search-count]');
	const noResults = root.querySelector<HTMLElement>('[data-iot-hub-no-results]');
	const fetchError = root.querySelector<HTMLElement>('[data-iot-hub-fetch-error]');
	const retryBtn = root.querySelector<HTMLButtonElement>(
		'[data-iot-hub-fetch-error-retry]'
	);
	if (!input || !resultsContainer || !itemsWrap || !countEl || !noResults) return;

	const sectionTmpl = document.querySelector<HTMLTemplateElement>(
		'[data-grouped-section-tmpl]'
	);
	const previewTmpl = document.querySelector<HTMLTemplateElement>(
		'[data-listing-card-tmpl][data-variant="preview"]'
	);
	const compactTmpl = document.querySelector<HTMLTemplateElement>(
		'[data-listing-card-tmpl][data-variant="compact"]'
	);
	const tileTmpl = document.querySelector<HTMLTemplateElement>(
		'[data-listing-card-tmpl][data-variant="tile"]'
	);
	// A mixed grid (search / creator) forces one layout on every card and picks
	// the clone by image presence, so it needs `preview` + `tile`. A grid pinned
	// to one item type clones per item, so it needs `preview` + `compact`.
	// Require only what this page uses: the flag above is already set, so an
	// over-strict guard here kills dynamic search with no way to retry.
	const mixedGrid = !itemType;
	const alt = mixedGrid ? tileTmpl : compactTmpl;
	if (!previewTmpl || !alt) return;
	// Bind the narrowed values so buildCardNode needs no assertions.
	const previewTemplate = previewTmpl;
	const altTemplate = alt;

	// Can this page render sections at all? A build-time fact: the section
	// template only exists where GroupedResultsPanel emitted it, and a pinned
	// item type means the page is already one type. Without the template the
	// surface degrades to the flat path rather than rendering nothing.
	const sectionTemplate = root.hasAttribute('data-grouped') && !itemType ? sectionTmpl : null;

	let searchText = '';
	let sortId: string = DEFAULT_IOT_HUB_SORT_ID;
	// Set the moment the visitor picks a sort themselves. Until then, typing in
	// the field is allowed to choose "Most relevant" for them (see effectiveSortId).
	let sortChosenByUser = false;
	// `?type=` on a grouped surface. Narrows the answer to one type, which ends
	// the grouped state — see the module header.
	let urlItemType = '';
	let pageSize = initialPageSize;
	let currentPage = 1;
	let abort: AbortController | null = null;
	let debounceTimer: number | undefined;
	let retryTimer: number | undefined;
	// FilterPanel selections keyed by section key (vendor, useCase, …).
	// Values are the raw checkbox values; labels live with the chips.
	let filters: Record<string, string[]> = {};
	// Last refetch options, replayed when the user clicks "Try again"
	// after a fetch error. resetPage=false keeps the page index the user
	// was on when the failure happened.
	let lastRefetchOpts: { resetPage?: boolean } = { resetPage: false };
	let lastTrackedQuery: string | null = null;

	// --- Surface state -----------------------------------------------------

	/** The item type every request is scoped to, pinned or picked from `?type=`. */
	function typeFilter(): string {
		return itemType || urlItemType;
	}

	/** Grouped exactly while the surface can render sections AND is not one type. */
	function isGrouped(): boolean {
		return sectionTemplate !== null && !urlItemType;
	}

	/**
	 * The sort the request and the sort control must both use. "Most relevant" is
	 * what a grouped surface shows while the field has text — an empty field has
	 * nothing to be relevant to, and the backend substitutes installCount there
	 * anyway. Derived rather than stored, so clearing the field restores the
	 * visitor's own choice instead of stranding them on a relevance sort with
	 * nothing to rank.
	 */
	function effectiveSortId(): string {
		if (sortChosenByUser || !isGrouped() || !searchText.trim()) return sortId;
		return 'most-relevant';
	}

	// Push an `iot_hub_query` event to dataLayer once per changed query state
	// (search text + active filters). Pagination, sort and repeats don't
	// re-count. Marketing owns the GTM trigger + GA4 tag.
	function trackQuery(term: string, resultsCount: number): void {
		// Canonical (key- and value-sorted) string so the same selection always
		// yields the same de-dupe key; copy before sorting to avoid mutating state.
		const activeFilters = Object.entries(filters)
			.map(([k, v]) => `${k}:${[...v].sort().join(',')}`)
			.sort()
			.join(';');
		// Nothing meaningful to report on a default, unfiltered browse.
		if (!term && !activeFilters) {
			lastTrackedQuery = null;
			return;
		}
		const key = `${term} ${activeFilters}`;
		if (key === lastTrackedQuery) return;
		lastTrackedQuery = key;
		window.dataLayer?.push({
			event: 'iot_hub_query',
			search_term: term,
			search_filters: activeFilters,
			search_results_count: resultsCount,
			search_surface: typeFilter() || (creatorId ? 'creator' : 'all'),
			search_sort: effectiveSortId(),
		});
	}

	function setLoading(loading: boolean): void {
		itemsWrap!.classList.toggle('is-loading', loading);
	}

	function showNoResults(show: boolean): void {
		noResults!.hidden = !show;
		if (show) resultsContainer!.replaceChildren();
	}

	// The bar is hidden by an error, and by the grouped state — a grouped answer
	// is one screen, so neither the page numbers nor the items-per-page control
	// describes anything on it. Both conditions are re-evaluated here so the two
	// cannot fight: leaving the grouped state must not un-hide an errored bar,
	// and a successful grouped fetch must not un-hide it at all.
	function syncPaginationBar(errored: boolean): void {
		if (!paginationBar) return;
		paginationBar.hidden = errored || isGrouped();
	}

	function showFetchError(show: boolean): void {
		if (!fetchError) return;
		fetchError.hidden = !show;
		if (show) {
			resultsContainer!.replaceChildren();
			noResults!.hidden = true;
		}
		syncPaginationBar(show);
	}

	// --- URL state sync ---------------------------------------------------

	function syncUrl(): void {
		const params = new URLSearchParams();
		const trimmed = searchText.trim();
		if (trimmed) params.set('q', trimmed);
		// `sortId` is what the visitor chose, never the relevance the field implied:
		// `?q=…` already says the answer is ranked by relevance, and writing it
		// down would freeze it into a link that outlives the text it ranked.
		if (sortId !== DEFAULT_IOT_HUB_SORT_ID) params.set('sort', sortId);
		// Keeps a section drill-down shareable and reloadable as itself.
		if (urlItemType) params.set('type', urlItemType);
		// A grouped answer has no pages and no page size — writing either would
		// promise a state the surface cannot restore.
		if (!isGrouped()) {
			if (currentPage > 1) params.set('page', String(currentPage));
			if (pageSize !== initialPageSize) params.set('pageSize', String(pageSize));
		}
		for (const [key, values] of Object.entries(filters)) {
			if (values.length === 0) continue;
			params.set(filterParamName(key, typeFilter()), values.join(','));
		}
		const query = params.toString();
		const next = basePath + (query ? `?${query}` : '') + location.hash;
		if (next !== location.pathname + location.search + location.hash) {
			history.replaceState(history.state, '', next);
		}
	}

	function applySortToUi(id: string): void {
		const sortRoot = root!.querySelector<HTMLElement>('[data-iot-hub-sort]');
		if (!sortRoot) return;
		const target = sortRoot.querySelector<HTMLButtonElement>(
			`[data-sort-option][data-sort-option-id="${id}"]`
		);
		if (!target) return;
		sortRoot.querySelectorAll<HTMLButtonElement>('[data-sort-option]').forEach((opt) => {
			const isSelected = opt === target;
			opt.classList.toggle('iot-hub-sort__option--selected', isSelected);
			opt.setAttribute('aria-pressed', String(isSelected));
		});
		const labelEl = sortRoot.querySelector<HTMLElement>('[data-sort-label]');
		const optText = target.querySelector<HTMLElement>('.iot-hub-sort__option-text')?.textContent;
		if (labelEl && optText) labelEl.textContent = optText;
		sortRoot.dataset.sortId = id;
	}

	function applyPageSizeToUi(size: number): void {
		const perPageRoot = root!.querySelector<HTMLElement>('[data-per-page-root]');
		if (perPageRoot) setPerPageValue(perPageRoot, size);
	}

	// --- DOM builders ------------------------------------------------------

	function buildCardNode(item: ListingView, categorySlug: string): HTMLElement {
		// Resolve the preview once: it decides the shape here, and the binder
		// reuses the URL rather than deriving it again. Shape is passed rather
		// than inferred — on a mixed grid it turns on image presence, not on
		// item type, so the binder could not work it out from the item alone.
		const previewUrl = resolvePreviewImage(item.image);
		const shape: CardShape = mixedGrid
			? previewUrl
				? 'preview'
				: 'tile'
			: getCardVariant(item.itemType) === 'big'
				? 'preview'
				: 'compact';

		const tmpl = shape === 'preview' ? previewTemplate : altTemplate;
		const card = tmpl.content.firstElementChild!.cloneNode(true) as HTMLElement;
		bindListingCard(card, item, categorySlug, { shape, showCreator, previewUrl });
		return card;
	}

	// The grid element itself is built here rather than cloned: ListingGrid's
	// styles are `is:global`, so a runtime-created div with the same classes is
	// styled identically. Only the cards and the section shell carry scoped
	// styles, and both of those are cloned from templates.
	function buildGrid(items: ListingView[], pinnedSlug: string | null): HTMLElement {
		const gridVariant = itemType ? getCardVariant(itemType) : 'big';
		const grid = document.createElement('div');
		grid.className = `iot-hub-grid iot-hub-grid--${gridVariant}`;
		for (const item of items) {
			// Pinned page: one category slug for every card. Mixed page (search /
			// creator): resolved per item, skipping types with no public category
			// rather than emitting a `/iot-hub//slug/` href.
			const slug = pinnedSlug ?? getCategoryForItemType(item.itemType)?.slug;
			if (!slug) continue;
			grid.appendChild(buildCardNode(item, slug));
		}
		return grid;
	}

	function renderFlat(items: ListingView[]): void {
		const cat = itemType ? getCategoryForItemType(itemType) : null;
		const grid = buildGrid(items, cat ? cat.slug : null);
		if (!grid.childElementCount) {
			showNoResults(true);
			return;
		}
		resultsContainer!.appendChild(grid);
	}

	// One [data-grouped-section] per type the answer contains, in
	// IOT_HUB_TYPE_ORDER, each cloned from the section template and filled by
	// bindGroupedSection. The "+N more" arithmetic and the header's href (which
	// stays on the creator profile when there is a creatorId) belong to
	// toGroupedSections — this only renders what it returns.
	function renderSections(items: ListingView[]): void {
		const sections = toGroupedSections(items, { query: searchText, creatorId });
		for (const section of sections) {
			const grid = buildGrid(section.items, null);
			// Every row of the section was dropped by getKnownSlugs (or has no
			// public category): an empty section under a populated header is worse
			// than no section.
			if (!grid.childElementCount) continue;
			const node = sectionTemplate!.content.firstElementChild!.cloneNode(true) as HTMLElement;
			bindGroupedSection(node, section);
			node.appendChild(grid);
			resultsContainer!.appendChild(node);
		}
		if (!resultsContainer!.childElementCount) showNoResults(true);
	}

	function renderResults(items: ListingView[]): void {
		if (items.length === 0) {
			showNoResults(true);
			return;
		}
		showNoResults(false);
		resultsContainer!.replaceChildren();
		if (isGrouped()) renderSections(items);
		else renderFlat(items);
	}

	// --- Fetch -------------------------------------------------------------

	async function refetch(opts: { resetPage?: boolean } = {}): Promise<void> {
		lastRefetchOpts = opts;
		const grouped = isGrouped();
		// A grouped answer is one screen; there is no page index to keep.
		if (opts.resetPage || grouped) currentPage = 1;
		syncUrl();
		if (abort) abort.abort();
		abort = new AbortController();
		// The error panel is left in place across every refetch — only a
		// successful response (below) is allowed to take it down. The
		// loading overlay still runs on top so the user sees that the
		// request is in flight.
		setLoading(true);
		// One resolution of the sort for both the request and the control, so the
		// label and the ordering cannot tell different stories.
		const activeSortId = effectiveSortId();
		applySortToUi(activeSortId);
		const sort = getIotHubSortOption(activeSortId);
		const params = new URLSearchParams({
			page: String(currentPage - 1), // backend is 0-based
			sortProperty: sort.sortProperty,
			sortOrder: sort.sortOrder,
		});
		// No pageSize on a grouped request: the server sizes the answer itself
		// (one cap per item type), and a client-side number here would be a second
		// source of truth about its shape — and a thing to forget when a type is
		// added. It is what made sections vanish in the first place.
		if (grouped) params.set('grouped', 'true');
		else params.set('pageSize', String(pageSize));
		const trimmed = searchText.trim();
		if (trimmed) params.set('textSearch', trimmed);
		if (creatorId) params.set('creatorId', creatorId);
		if (typeFilter()) params.set('type', typeFilter());
		for (const [key, values] of Object.entries(filters)) {
			if (values.length === 0) continue;
			params.set(filterParamName(key, typeFilter()), values.join(','));
		}

		try {
			const [res, knownSlugs] = await Promise.all([
				fetch(
					`${IOT_HUB_API_URL}/api/listings/published?${params.toString()}`,
					{ signal: abort.signal }
				),
				getKnownSlugs(),
			]);
			if (!res.ok) {
				// 4xx/5xx — treat the same as a network error so the user
				// gets a recoverable "Try again" path instead of stale data.
				showFetchError(true);
				return;
			}
			const body = (await res.json()) as PageData<ListingView>;
			// Drop listings published after the last deploy — no static
			// detail page exists for them yet. Trade-off: a page may show
			// < pageSize items until the next rebuild.
			const items = (body.data ?? []).filter((item) => knownSlugs.has(item.slug));
			const totalPages = Math.max(1, body.totalPages || 1);
			// Only a successful response is allowed to take the error
			// panel down — every other refetch trigger leaves it alone.
			showFetchError(false);
			renderResults(items);
			if (paginationNav && !grouped) {
				// Hide the page-number nav when a filter narrows results to a
				// single page, matching the other surfaces. Safe here because the
				// per-page selector lives in the bar (sibling of the nav), so it
				// stays visible — letting the user lower the page size again.
				updatePagination(paginationNav, { currentPage, totalPages, hideOnSinglePage: true });
			}
			updateResultsCount(countEl!, body.totalElements ?? 0);
			trackQuery(trimmed, body.totalElements ?? 0);
		} catch (err) {
			// Aborts happen on every superseding fetch — don't treat them
			// as failures or the error panel would flash on every keystroke.
			if (err instanceof DOMException && err.name === 'AbortError') return;
			showFetchError(true);
		} finally {
			setLoading(false);
		}
	}

	// --- Initial URL state -------------------------------------------------

	const urlParams = new URLSearchParams(location.search);
	let hasUrlState = false;

	const urlQ = urlParams.get('q') ?? '';
	if (urlQ) {
		searchText = urlQ;
		if (!input.value) input.value = urlQ;
		hasUrlState = true;
	}

	const urlSort = urlParams.get('sort') ?? '';
	if (urlSort && getIotHubSortOption(urlSort).id === urlSort) {
		sortId = urlSort;
		// A sort in the URL is a choice the visitor made earlier — typing does not
		// get to overrule it any more than it would in the same session.
		sortChosenByUser = true;
		applySortToUi(sortId);
		if (urlSort !== DEFAULT_IOT_HUB_SORT_ID) hasUrlState = true;
	}

	// `?type=` only means anything on a grouped surface with no pinned type: it is
	// how a section header drills into one type without leaving the page (the
	// creator profile's "Widgets ›" must stay on the profile). An unknown value is
	// ignored rather than silently ungrouping the page.
	const urlType = urlParams.get('type') ?? '';
	if (sectionTemplate && urlType && getCategoryForItemType(urlType)) {
		urlItemType = urlType;
		hasUrlState = true;
	}

	const urlPageSize = Number.parseInt(urlParams.get('pageSize') ?? '', 10);
	if (Number.isFinite(urlPageSize) && urlPageSize > 0) {
		pageSize = urlPageSize;
		applyPageSizeToUi(pageSize);
		if (urlPageSize !== initialPageSize) hasUrlState = true;
	}

	const urlPage = Number.parseInt(urlParams.get('page') ?? '', 10);
	if (Number.isFinite(urlPage) && urlPage > 1) {
		currentPage = urlPage;
		hasUrlState = true;
	}

	for (const paramName of FILTER_PARAM_NAMES) {
		const value = urlParams.get(paramName);
		if (!value) continue;
		const key = PARAM_TO_FILTER_KEY[paramName];
		if (!key) continue;
		const values = value.split(',').filter(Boolean);
		if (values.length === 0) continue;
		// Merge so the three `type` aliases collapse into one section if
		// they ever appear together in a URL.
		filters[key] = Array.from(new Set([...(filters[key] ?? []), ...values]));
		hasUrlState = true;
	}

	// Re-check the matching FilterPanel checkboxes so the panel reflects
	// the restored URL state, then emit a change so chips render. rAF
	// defers this past FilterPanel's own DOMContentLoaded init so the
	// change listener is in place when the synthetic event fires.
	if (Object.keys(filters).length > 0) {
		requestAnimationFrame(() => {
			const panel = document.querySelector<HTMLElement>('[data-iot-hub-filter-panel]');
			if (!panel) return;
			for (const [key, values] of Object.entries(filters)) {
				for (const value of values) {
					const cb = panel.querySelector<HTMLInputElement>(
						`.iot-hub-filter-option__input[name="${CSS.escape(key)}"][value="${CSS.escape(value)}"]`
					);
					if (cb) cb.checked = true;
				}
			}
			const anyInput = panel.querySelector<HTMLInputElement>(
				'.iot-hub-filter-option__input'
			);
			if (anyInput) anyInput.dispatchEvent(new Event('change', { bubbles: true }));
		});
	}

	if (hasUrlState) {
		void refetch({ resetPage: false });
	}

	// --- Event listeners ---------------------------------------------------

	root.addEventListener('iot-hub-search-text:change', ((e: CustomEvent) => {
		searchText = e.detail?.searchText ?? '';
		if (debounceTimer !== undefined) clearTimeout(debounceTimer);
		// setLoading kept inside refetch so the spinner only flashes once
		// the fetch is actually in flight, not on every keystroke.
		debounceTimer = window.setTimeout(() => {
			void refetch({ resetPage: true });
		}, DEBOUNCE_MS);
	}) as EventListener);

	root.addEventListener('iot-hub-sort:change', ((e: CustomEvent) => {
		sortId = e.detail?.id ?? DEFAULT_IOT_HUB_SORT_ID;
		// From here on the visitor owns the sort: typing no longer switches the
		// control to "Most relevant" behind their back.
		sortChosenByUser = true;
		void refetch({ resetPage: true });
	}) as EventListener);

	root.addEventListener('tb-pagination:page-size-change', ((e: CustomEvent) => {
		const next = Number.parseInt(e.detail?.perPage ?? '0', 10);
		if (!Number.isFinite(next) || next <= 0) return;
		pageSize = next;
		void refetch({ resetPage: true });
	}) as EventListener);

	root.addEventListener('tb-pagination:page-change', ((e: CustomEvent) => {
		const next = Number.parseInt(e.detail?.page ?? '0', 10);
		if (!Number.isFinite(next) || next <= 0) return;
		currentPage = next;
		void refetch({ resetPage: false });
	}) as EventListener);

	const RETRY_DEBOUNCE_MS = 350;
	retryBtn?.addEventListener('click', () => {
		// Flip the loading overlay on right away so rapid clicks feel
		// responsive, then debounce the actual fetch by 350ms so a burst
		// of clicks collapses into a single API call. `resetPage` carries
		// the flag from the call that failed, so "Try again" keeps the
		// user's page index intact deep into results.
		setLoading(true);
		if (retryTimer !== undefined) clearTimeout(retryTimer);
		retryTimer = window.setTimeout(() => {
			retryTimer = undefined;
			void refetch(lastRefetchOpts);
		}, RETRY_DEBOUNCE_MS);
	});

	// FilterPanel emits this on any checkbox change (real or synthetic).
	// Guard against the synthetic emit fired during URL restore by
	// comparing values — if the incoming state already matches what we
	// reconstructed from the URL, skip the refetch (the chip strip still
	// renders, since ListingsFilterBar listens to the same event).
	root.addEventListener('iot-hub-filter:change', ((e: CustomEvent) => {
		const incoming = (e.detail?.filters ?? {}) as Record<
			string,
			Array<{ value: string; label: string }>
		>;
		const next: Record<string, string[]> = {};
		for (const [key, entries] of Object.entries(incoming)) {
			if (entries.length > 0) next[key] = entries.map((entry) => entry.value);
		}
		if (filtersEqual(filters, next)) return;
		filters = next;
		void refetch({ resetPage: true });
	}) as EventListener);
}

export function initDynamicSearch(): void {
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', setupDynamicSearch);
	} else {
		setupDynamicSearch();
	}
}
