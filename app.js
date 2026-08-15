"use strict";

const DEFAULT_CATEGORY = "すべて";

const state = {
  extensions: [],
  categories: [DEFAULT_CATEGORY],
  selectedCategory: DEFAULT_CATEGORY,
  searchQuery: "",
  sortBy: "relevance"
};

const elements = {
  loading: document.querySelector("#loading"),
  error: document.querySelector("#error"),
  list: document.querySelector("#list-view"),
  detail: document.querySelector("#detail-view"),
  notFound: document.querySelector("#not-found-view"),
  extensionList: document.querySelector("#extension-list"),
  extensionCount: document.querySelector("#extension-count"),
  extensionDetail: document.querySelector("#extension-detail"),
  emptyState: document.querySelector("#empty-state"),
  categoryTabs: document.querySelector("#category-tabs"),
  sidebarCategories: document.querySelector("#sidebar-categories"),
  searchInput: document.querySelector("#search-input"),
  searchClear: document.querySelector("#search-clear"),
  sortSelect: document.querySelector("#sort-select"),
  resetFiltersBtn: document.querySelector("#reset-filters-btn"),
  clearCategoryBtn: document.querySelector("#clear-category-btn")
};

function formatDate(dateString) {
  const date = new Date(`${dateString}T00:00:00`);
  if (Number.isNaN(date.getTime())) {
    return dateString;
  }
  return new Intl.DateTimeFormat("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric"
  }).format(date);
}

function getInitialLetter(name) {
  if (!name || typeof name !== "string") {
    return "TW";
  }
  const clean = name.trim();
  return clean.slice(0, 2).toUpperCase();
}

function currentId() {
  const match = window.location.hash.match(/^#\/extensions\/([^/?#]+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function hideViews() {
  const views = [elements.list, elements.detail, elements.notFound];
  for (const view of views) {
    view.hidden = true;
  }
}

function filterAndSortExtensions(extensions, selectedCategory, searchQuery, sortBy) {
  const query = searchQuery.trim().toLowerCase();

  const filtered = extensions.filter((item) => {
    const matchCategory =
      selectedCategory === DEFAULT_CATEGORY || item.category === selectedCategory;
    if (!matchCategory) {
      return false;
    }

    if (!query) {
      return true;
    }

    const nameMatch = item.name && item.name.toLowerCase().includes(query);
    const summaryMatch = item.summary && item.summary.toLowerCase().includes(query);
    const authorMatch = item.author && item.author.toLowerCase().includes(query);
    const tagMatch =
      Array.isArray(item.tags) &&
      item.tags.some((tag) => tag.toLowerCase().includes(query));

    return nameMatch || summaryMatch || authorMatch || tagMatch;
  });

  return filtered.sort((a, b) => {
    if (sortBy === "updated") {
      return (b.updatedAt || "").localeCompare(a.updatedAt || "");
    }
    if (sortBy === "name") {
      return (a.name || "").localeCompare(b.name || "", "ja");
    }
    return 0;
  });
}

function renderCategoryTabs() {
  elements.categoryTabs.replaceChildren();

  for (const category of state.categories) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "category-tab-btn";
    if (category === state.selectedCategory) {
      button.classList.add("active");
    }
    button.textContent = category;

    button.addEventListener("click", () => {
      state.selectedCategory = category;
      renderCategoryTabs();
      renderSidebarCategories();
      renderList();
    });

    elements.categoryTabs.append(button);
  }
}

function renderSidebarCategories() {
  elements.sidebarCategories.replaceChildren();

  for (const category of state.categories) {
    const item = document.createElement("div");
    item.className = "filter-category-item";
    if (category === state.selectedCategory) {
      item.classList.add("active");
    }

    const nameSpan = document.createElement("span");
    nameSpan.textContent = category;

    const countSpan = document.createElement("span");
    const count =
      category === DEFAULT_CATEGORY
        ? state.extensions.length
        : state.extensions.filter((ext) => ext.category === category).length;
    countSpan.textContent = String(count);

    item.append(nameSpan, countSpan);

    item.addEventListener("click", () => {
      state.selectedCategory = category;
      renderCategoryTabs();
      renderSidebarCategories();
      renderList();
    });

    elements.sidebarCategories.append(item);
  }
}

function createExtensionCard(extension) {
  const card = document.createElement("article");
  card.className = "extension-row-card";

  // アイコンボックス
  const iconBox = document.createElement("div");
  iconBox.className = "card-icon-box";
  iconBox.textContent = getInitialLetter(extension.name);

  // コンテンツ
  const content = document.createElement("div");
  content.className = "card-content";

  // タイトル行
  const titleRow = document.createElement("div");
  titleRow.className = "card-title-row";

  const title = document.createElement("h3");
  title.className = "card-title";
  title.textContent = extension.name;

  const author = document.createElement("span");
  author.className = "card-author";
  author.textContent = "by ";
  const authorName = document.createElement("span");
  authorName.textContent = extension.author || "コミュニティ";
  author.append(authorName);

  titleRow.append(title, author);

  // サマリー
  const summary = document.createElement("p");
  summary.className = "card-summary";
  summary.textContent = extension.summary;

  // タグ行
  const tagsRow = document.createElement("div");
  tagsRow.className = "card-tags-row";

  if (extension.category) {
    const catTag = document.createElement("span");
    catTag.className = "tag-pill category-pill";
    catTag.textContent = extension.category;
    tagsRow.append(catTag);
  }

  if (Array.isArray(extension.tags)) {
    for (const tag of extension.tags) {
      const tagPill = document.createElement("span");
      tagPill.className = "tag-pill";
      tagPill.textContent = tag;
      tagsRow.append(tagPill);
    }
  }

  content.append(titleRow, summary, tagsRow);

  // アクション & 統計列
  const actionsCol = document.createElement("div");
  actionsCol.className = "card-actions-col";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn btn-primary";
  button.textContent = "+ 詳細・DL";
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    window.location.hash = `#/extensions/${encodeURIComponent(extension.id)}`;
  });

  const stats = document.createElement("div");
  stats.className = "card-stats";

  const versionSpan = document.createElement("span");
  versionSpan.className = "stat-item";
  versionSpan.textContent = `v${extension.version}`;

  const updatedSpan = document.createElement("span");
  updatedSpan.className = "stat-item";
  updatedSpan.textContent = formatDate(extension.updatedAt);

  stats.append(versionSpan, updatedSpan);
  actionsCol.append(button, stats);

  card.append(iconBox, content, actionsCol);

  // カード全体のクリックで詳細へ
  card.addEventListener("click", () => {
    window.location.hash = `#/extensions/${encodeURIComponent(extension.id)}`;
  });

  return card;
}

function renderList() {
  hideViews();
  elements.list.hidden = false;

  const filtered = filterAndSortExtensions(
    state.extensions,
    state.selectedCategory,
    state.searchQuery,
    state.sortBy
  );

  elements.extensionCount.textContent = `${filtered.length}件の拡張機能`;
  elements.emptyState.hidden = filtered.length !== 0;
  elements.extensionList.hidden = filtered.length === 0;

  elements.extensionList.replaceChildren();
  const fragment = document.createDocumentFragment();

  for (const extension of filtered) {
    fragment.append(createExtensionCard(extension));
  }

  elements.extensionList.append(fragment);
}

function createChangelogTimeline(changelog) {
  const timeline = document.createElement("ul");
  timeline.className = "changelog-timeline";

  const sorted = [...changelog].sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  for (const entry of sorted) {
    const item = document.createElement("li");
    item.className = "changelog-entry";

    const header = document.createElement("div");
    header.className = "changelog-entry-header";

    const versionSpan = document.createElement("span");
    versionSpan.className = "changelog-version";
    versionSpan.textContent = `v${entry.version}`;

    const dateSpan = document.createElement("span");
    dateSpan.className = "changelog-date";
    dateSpan.textContent = formatDate(entry.date);

    header.append(versionSpan, dateSpan);

    const ul = document.createElement("ul");
    ul.className = "changelog-changes-list";
    if (Array.isArray(entry.changes)) {
      for (const change of entry.changes) {
        const li = document.createElement("li");
        li.textContent = change;
        ul.append(li);
      }
    }

    item.append(header, ul);
    timeline.append(item);
  }

  return timeline;
}

function renderDetail(extension) {
  hideViews();
  elements.detail.hidden = false;

  elements.extensionDetail.replaceChildren();

  // メインカラム
  const mainCol = document.createElement("div");
  mainCol.className = "detail-main-col";

  // ヒーローパネル
  const heroPanel = document.createElement("div");
  heroPanel.className = "detail-hero-panel";

  const icon = document.createElement("div");
  icon.className = "detail-hero-icon";
  icon.textContent = getInitialLetter(extension.name);

  const heroBody = document.createElement("div");
  heroBody.className = "detail-hero-body";

  const titleLine = document.createElement("div");
  titleLine.className = "detail-title-line";

  const title = document.createElement("h1");
  title.className = "detail-title";
  title.textContent = extension.name;

  const versionTag = document.createElement("span");
  versionTag.className = "tag-pill category-pill";
  versionTag.textContent = `v${extension.version}`;

  titleLine.append(title, versionTag);

  const authorLine = document.createElement("div");
  authorLine.className = "detail-author-line";
  authorLine.textContent = "作成者: ";
  const authorStrong = document.createElement("strong");
  authorStrong.textContent = extension.author || "コミュニティ";
  authorLine.append(authorStrong);

  const summary = document.createElement("p");
  summary.className = "card-summary";
  summary.textContent = extension.summary;

  const actionsRow = document.createElement("div");
  actionsRow.className = "detail-actions-row";

  const downloadBtn = document.createElement("a");
  downloadBtn.className = "btn btn-primary";
  downloadBtn.href = encodeURI(extension.file);
  downloadBtn.setAttribute("download", "");
  downloadBtn.textContent = "JavaScriptをダウンロード";

  const openEditorBtn = document.createElement("a");
  openEditorBtn.className = "btn btn-outline";
  openEditorBtn.href = `https://turbowarp.org/editor?extension=${encodeURIComponent(new URL(extension.file, window.location.href).href)}`;
  openEditorBtn.target = "_blank";
  openEditorBtn.rel = "noopener noreferrer";
  openEditorBtn.textContent = "TurboWarpで開く ↗";

  actionsRow.append(downloadBtn, openEditorBtn);
  heroBody.append(titleLine, authorLine, summary, actionsRow);
  heroPanel.append(icon, heroBody);

  // 説明カード
  const descCard = document.createElement("div");
  descCard.className = "detail-card";

  const descHeading = document.createElement("h3");
  descHeading.textContent = "拡張機能の説明";

  const descText = document.createElement("p");
  descText.className = "detail-description-text";
  descText.textContent = extension.description;

  descCard.append(descHeading, descText);

  // 変更履歴カード
  const changelogCard = document.createElement("div");
  changelogCard.className = "detail-card";

  const changelogHeading = document.createElement("h3");
  changelogHeading.textContent = "バージョン更新履歴";

  const changelogContent = createChangelogTimeline(extension.changelog || []);
  changelogCard.append(changelogHeading, changelogContent);

  mainCol.append(heroPanel, descCard, changelogCard);

  // サイドカラム（メタ情報）
  const sideCol = document.createElement("div");
  sideCol.className = "detail-side-col";

  const metaCard = document.createElement("div");
  metaCard.className = "sidebar-card";

  const metaHeader = document.createElement("div");
  metaHeader.className = "sidebar-header";
  const metaTitle = document.createElement("h3");
  metaTitle.textContent = "メタ情報";
  metaHeader.append(metaTitle);

  const metaList = document.createElement("ul");
  metaList.className = "meta-info-list";

  const metaItems = [
    { label: "最新バージョン", value: `v${extension.version}` },
    { label: "更新日", value: formatDate(extension.updatedAt) },
    { label: "カテゴリ", value: extension.category || "その他" },
    { label: "ファイル名", value: extension.file.split("/").pop() },
    { label: "プラットフォーム", value: "TurboWarp" }
  ];

  for (const item of metaItems) {
    const li = document.createElement("li");
    li.className = "meta-info-item";

    const labelSpan = document.createElement("span");
    labelSpan.className = "meta-label";
    labelSpan.textContent = item.label;

    const valueSpan = document.createElement("span");
    valueSpan.className = "meta-value";
    valueSpan.textContent = item.value;

    li.append(labelSpan, valueSpan);
    metaList.append(li);
  }

  metaCard.append(metaHeader, metaList);
  sideCol.append(metaCard);

  elements.extensionDetail.append(mainCol, sideCol);
}

function renderNotFound() {
  hideViews();
  elements.notFound.hidden = false;
}

function renderRoute() {
  const id = currentId();
  if (!id || window.location.hash === "#/") {
    renderList();
    return;
  }
  const extension = state.extensions.find((item) => item.id === id);
  if (extension) {
    renderDetail(extension);
  } else {
    renderNotFound();
  }
}

function setupEventListeners() {
  // 検索インプット
  elements.searchInput.addEventListener("input", (event) => {
    state.searchQuery = event.target.value;
    elements.searchClear.hidden = !state.searchQuery;
    renderList();
  });

  // 検索クリアボタン
  elements.searchClear.addEventListener("click", () => {
    state.searchQuery = "";
    elements.searchInput.value = "";
    elements.searchClear.hidden = true;
    renderList();
  });

  // ソート選択
  elements.sortSelect.addEventListener("change", (event) => {
    state.sortBy = event.target.value;
    renderList();
  });

  // フィルター全解除
  elements.resetFiltersBtn.addEventListener("click", () => {
    state.selectedCategory = DEFAULT_CATEGORY;
    state.searchQuery = "";
    elements.searchInput.value = "";
    elements.searchClear.hidden = true;
    renderCategoryTabs();
    renderSidebarCategories();
    renderList();
  });

  // カテゴリクリア
  elements.clearCategoryBtn.addEventListener("click", () => {
    state.selectedCategory = DEFAULT_CATEGORY;
    renderCategoryTabs();
    renderSidebarCategories();
    renderList();
  });

  // ルーティング
  window.addEventListener("hashchange", renderRoute);
}

async function start() {
  try {
    const response = await fetch("data/extensions.json", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("拡張機能データを取得できませんでした。");
    }
    const data = await response.json();
    if (!Array.isArray(data.extensions)) {
      throw new Error("拡張機能データの形式が正しくありません。");
    }

    state.extensions = data.extensions;
    if (Array.isArray(data.categories)) {
      state.categories = data.categories;
    }

    elements.loading.hidden = true;
    setupEventListeners();
    renderCategoryTabs();
    renderSidebarCategories();
    renderRoute();
  } catch (error) {
    elements.loading.hidden = true;
    elements.error.hidden = false;
    if (window.location.protocol === "file:") {
      elements.error.textContent =
        "このページはファイルとして直接開かれています。GitHub Pagesで公開したURLを開くか、ローカルWebサーバー（VS Code Live Server等）から開いてください。";
    } else {
      elements.error.textContent = `表示の準備中に問題が発生しました: ${error.message}`;
    }
  }
}

start();
