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
  categoryChips: document.querySelector("#category-chips"),
  searchInput: document.querySelector("#search-input"),
  searchClear: document.querySelector("#search-clear"),
  sortSelect: document.querySelector("#sort-select"),
  resetFiltersBtn: document.querySelector("#reset-filters-btn")
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

function renderCategoryChips() {
  elements.categoryChips.replaceChildren();

  for (const category of state.categories) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "category-chip";
    if (category === state.selectedCategory) {
      chip.classList.add("active");
    }
    chip.textContent = category;

    chip.addEventListener("click", () => {
      state.selectedCategory = category;
      renderCategoryChips();
      renderList();
    });

    elements.categoryChips.append(chip);
  }
}

function createExtensionCard(extension) {
  const card = document.createElement("article");
  card.className = "extension-card";

  // 上部（アイコン ＋ タイトル/作者）
  const cardTop = document.createElement("div");
  cardTop.className = "card-top";

  const icon = document.createElement("div");
  icon.className = "card-icon";
  icon.textContent = getInitialLetter(extension.name);

  const heading = document.createElement("div");
  heading.className = "card-heading";

  const name = document.createElement("h3");
  name.className = "card-name";
  name.textContent = extension.name;

  const authorBadge = document.createElement("span");
  authorBadge.className = "card-author-badge";
  authorBadge.textContent = `by ${extension.author || "コミュニティ"}`;

  heading.append(name, authorBadge);
  cardTop.append(icon, heading);

  // 説明文
  const desc = document.createElement("p");
  desc.className = "card-desc";
  desc.textContent = extension.summary;

  // 下部（タグ ＋ アクション）
  const cardBottom = document.createElement("div");
  cardBottom.className = "card-bottom";

  const tags = document.createElement("div");
  tags.className = "card-tags";

  if (extension.category) {
    const categoryBadge = document.createElement("span");
    categoryBadge.className = "tag-badge category-badge";
    categoryBadge.textContent = extension.category;
    tags.append(categoryBadge);
  }

  const verBadge = document.createElement("span");
  verBadge.className = "tag-badge";
  verBadge.textContent = `v${extension.version}`;
  tags.append(verBadge);

  const linkAction = document.createElement("span");
  linkAction.className = "card-link-action";
  linkAction.textContent = "詳細を見る →";

  cardBottom.append(tags, linkAction);

  card.append(cardTop, desc, cardBottom);

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
  const list = document.createElement("ul");
  list.className = "changelog-list";

  const sorted = [...changelog].sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  for (const entry of sorted) {
    const item = document.createElement("li");
    item.className = "changelog-item";

    const head = document.createElement("div");
    head.className = "changelog-head";

    const ver = document.createElement("span");
    ver.className = "changelog-ver";
    ver.textContent = `v${entry.version}`;

    const time = document.createElement("span");
    time.className = "changelog-time";
    time.textContent = formatDate(entry.date);

    head.append(ver, time);

    const bullets = document.createElement("ul");
    bullets.className = "changelog-bullets";
    if (Array.isArray(entry.changes)) {
      for (const change of entry.changes) {
        const li = document.createElement("li");
        li.textContent = change;
        bullets.append(li);
      }
    }

    item.append(head, bullets);
    list.append(item);
  }

  return list;
}

function renderDetail(extension) {
  hideViews();
  elements.detail.hidden = false;

  elements.extensionDetail.replaceChildren();

  // ヘッダー行
  const headerRow = document.createElement("div");
  headerRow.className = "detail-header-row";

  const icon = document.createElement("div");
  icon.className = "detail-icon-large";
  icon.textContent = getInitialLetter(extension.name);

  const headerInfo = document.createElement("div");
  headerInfo.className = "detail-header-info";

  const titleWrap = document.createElement("div");
  titleWrap.className = "detail-title-wrap";

  const title = document.createElement("h1");
  title.className = "detail-main-title";
  title.textContent = extension.name;

  const verBadge = document.createElement("span");
  verBadge.className = "tag-badge category-badge";
  verBadge.textContent = `v${extension.version}`;

  titleWrap.append(title, verBadge);

  const metaText = document.createElement("p");
  metaText.className = "detail-meta-text";
  metaText.textContent = "作成者: ";
  const authorStrong = document.createElement("strong");
  authorStrong.textContent = extension.author || "コミュニティ";
  metaText.append(authorStrong);

  const summary = document.createElement("p");
  summary.className = "card-desc";
  summary.textContent = extension.summary;

  const actions = document.createElement("div");
  actions.className = "detail-actions";

  const downloadBtn = document.createElement("a");
  downloadBtn.className = "btn btn-primary";
  downloadBtn.href = encodeURI(extension.file);
  downloadBtn.setAttribute("download", "");
  downloadBtn.textContent = "JavaScriptをダウンロード";

  actions.append(downloadBtn);
  headerInfo.append(titleWrap, metaText, summary, actions);
  headerRow.append(icon, headerInfo);

  // 説明ブロック
  const descBlock = document.createElement("section");
  descBlock.className = "detail-block";

  const descTitle = document.createElement("h2");
  descTitle.textContent = "拡張機能の詳細";

  const descContent = document.createElement("p");
  descContent.className = "detail-description";
  descContent.textContent = extension.description;

  descBlock.append(descTitle, descContent);

  // メタ情報グリッド
  const metaBlock = document.createElement("section");
  metaBlock.className = "detail-block";

  const metaTitle = document.createElement("h2");
  metaTitle.textContent = "仕様・メタ情報";

  const metaGrid = document.createElement("div");
  metaGrid.className = "meta-grid";

  const metaFields = [
    { label: "最新バージョン", value: `v${extension.version}` },
    { label: "最終更新日", value: formatDate(extension.updatedAt) },
    { label: "カテゴリ", value: extension.category || "その他" },
    { label: "ファイル名", value: extension.file.split("/").pop() }
  ];

  for (const field of metaFields) {
    const fieldDiv = document.createElement("div");
    fieldDiv.className = "meta-field";

    const labelSpan = document.createElement("span");
    labelSpan.className = "meta-field-label";
    labelSpan.textContent = field.label;

    const valueSpan = document.createElement("span");
    valueSpan.className = "meta-field-value";
    valueSpan.textContent = field.value;

    fieldDiv.append(labelSpan, valueSpan);
    metaGrid.append(fieldDiv);
  }

  metaBlock.append(metaTitle, metaGrid);

  // 変更履歴ブロック
  const changelogBlock = document.createElement("section");
  changelogBlock.className = "detail-block";

  const changelogTitle = document.createElement("h2");
  changelogTitle.textContent = "バージョン更新履歴";

  const changelogList = createChangelogTimeline(extension.changelog || []);
  changelogBlock.append(changelogTitle, changelogList);

  elements.extensionDetail.append(headerRow, descBlock, metaBlock, changelogBlock);
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
  elements.searchInput.addEventListener("input", (event) => {
    state.searchQuery = event.target.value;
    elements.searchClear.hidden = !state.searchQuery;
    renderList();
  });

  elements.searchClear.addEventListener("click", () => {
    state.searchQuery = "";
    elements.searchInput.value = "";
    elements.searchClear.hidden = true;
    renderList();
  });

  elements.sortSelect.addEventListener("change", (event) => {
    state.sortBy = event.target.value;
    renderList();
  });

  elements.resetFiltersBtn.addEventListener("click", () => {
    state.selectedCategory = DEFAULT_CATEGORY;
    state.searchQuery = "";
    elements.searchInput.value = "";
    elements.searchClear.hidden = true;
    renderCategoryChips();
    renderList();
  });

  window.addEventListener("hashchange", renderRoute);
}

async function fetchExtensionData(extensionId) {
  const url = `data/extensions/${encodeURIComponent(extensionId)}.json`;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`拡張機能「${extensionId}」のデータを取得できませんでした。`);
  }
  return await response.json();
}

async function start() {
  try {
    const response = await fetch("data/index.json", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("インデックスデータ (data/index.json) を取得できませんでした。");
    }
    const indexData = await response.json();
    if (!Array.isArray(indexData.extensions)) {
      throw new Error("インデックスデータの形式が正しくありません。");
    }

    if (Array.isArray(indexData.categories)) {
      state.categories = indexData.categories;
    }

    const extensions = await Promise.all(
      indexData.extensions.map((id) => fetchExtensionData(id))
    );

    state.extensions = extensions;

    elements.loading.hidden = true;
    setupEventListeners();
    renderCategoryChips();
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
