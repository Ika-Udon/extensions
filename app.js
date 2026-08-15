"use strict";

const elements = {
  loading: document.querySelector("#loading"),
  error: document.querySelector("#error"),
  list: document.querySelector("#list-view"),
  detail: document.querySelector("#detail-view"),
  notFound: document.querySelector("#not-found-view"),
  extensionList: document.querySelector("#extension-list"),
  extensionCount: document.querySelector("#extension-count"),
  extensionDetail: document.querySelector("#extension-detail"),
  emptyState: document.querySelector("#empty-state")
};

let extensions = [];

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

function createExtensionCard(extension) {
  const card = document.createElement("article");
  card.className = "extension-card";

  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = `VERSION ${extension.version}`;

  const title = document.createElement("h3");
  title.textContent = extension.name;

  const summary = document.createElement("p");
  summary.textContent = extension.summary;

  const meta = document.createElement("div");
  meta.className = "card-meta";
  const updateSpan = document.createElement("span");
  updateSpan.textContent = `更新 ${formatDate(extension.updatedAt)}`;
  meta.append(updateSpan);

  const link = document.createElement("a");
  link.className = "card-link";
  link.href = `#/extensions/${encodeURIComponent(extension.id)}`;
  link.setAttribute("aria-label", `${extension.name}の詳細を見る`);
  link.textContent = "詳細・ダウンロード →";

  card.append(eyebrow, title, summary, meta, link);
  return card;
}

function renderList() {
  hideViews();
  elements.list.hidden = false;
  elements.extensionCount.textContent = `${extensions.length}件`;
  elements.emptyState.hidden = extensions.length !== 0;
  elements.extensionList.hidden = extensions.length === 0;

  elements.extensionList.replaceChildren();
  const fragment = document.createDocumentFragment();

  for (const extension of extensions) {
    fragment.append(createExtensionCard(extension));
  }

  elements.extensionList.append(fragment);
}

function createChangelogItem(entry) {
  const item = document.createElement("li");
  item.className = "changelog-item";

  const header = document.createElement("div");
  header.className = "change-header";

  const versionHeading = document.createElement("h4");
  versionHeading.textContent = `v${entry.version}`;

  const time = document.createElement("time");
  time.setAttribute("datetime", entry.date);
  time.textContent = formatDate(entry.date);

  header.append(versionHeading, time);

  const ul = document.createElement("ul");
  for (const change of entry.changes) {
    const li = document.createElement("li");
    li.textContent = change;
    ul.append(li);
  }

  item.append(header, ul);
  return item;
}

function renderDetail(extension) {
  hideViews();
  elements.detail.hidden = false;

  elements.extensionDetail.replaceChildren();

  const panel = document.createElement("div");
  panel.className = "detail-panel";

  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "TURBOWARP EXTENSION";

  const title = document.createElement("h1");
  title.className = "detail-title";
  title.textContent = extension.name;

  const meta = document.createElement("div");
  meta.className = "detail-meta";
  const versionSpan = document.createElement("span");
  versionSpan.textContent = `最新版 v${extension.version}`;
  const updateSpan = document.createElement("span");
  updateSpan.textContent = `更新 ${formatDate(extension.updatedAt)}`;
  meta.append(versionSpan, updateSpan);

  const description = document.createElement("p");
  description.className = "detail-description";
  description.textContent = extension.description;

  const downloadArea = document.createElement("div");
  downloadArea.className = "download-area";

  const downloadButton = document.createElement("a");
  downloadButton.className = "button button-primary";
  downloadButton.href = encodeURI(extension.file);
  downloadButton.setAttribute("download", "");
  downloadButton.textContent = "JavaScriptファイルをダウンロード";

  const fileNameText = extension.file.split("/").pop();
  const fileName = document.createElement("p");
  fileName.textContent = `最新版: ${fileNameText}`;

  downloadArea.append(downloadButton, fileName);

  const changelogSection = document.createElement("section");
  changelogSection.setAttribute("aria-labelledby", "changelog-title");

  const changelogHeading = document.createElement("h2");
  changelogHeading.id = "changelog-title";
  changelogHeading.className = "changelog-heading";
  changelogHeading.textContent = "変更履歴";

  const changelogList = document.createElement("ol");
  changelogList.className = "changelog";

  const sortedChangelog = [...extension.changelog].sort((a, b) => b.date.localeCompare(a.date));
  for (const entry of sortedChangelog) {
    changelogList.append(createChangelogItem(entry));
  }

  changelogSection.append(changelogHeading, changelogList);

  panel.append(eyebrow, title, meta, description, downloadArea, changelogSection);
  elements.extensionDetail.append(panel);
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
  const extension = extensions.find((item) => item.id === id);
  if (extension) {
    renderDetail(extension);
  } else {
    renderNotFound();
  }
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
    extensions = data.extensions;
    elements.loading.hidden = true;
    renderRoute();
    window.addEventListener("hashchange", renderRoute);
  } catch (error) {
    elements.loading.hidden = true;
    elements.error.hidden = false;
    if (window.location.protocol === "file:") {
      elements.error.textContent = "このページはファイルとして直接開かれています。GitHub Pagesで公開したURLを開くか、VS CodeのLive ServerなどのローカルWebサーバーから開いてください。";
    } else {
      elements.error.textContent = `表示の準備中に問題が発生しました: ${error.message}`;
    }
  }
}

start();
