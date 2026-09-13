const copyButton = document.querySelector("#copy-prompt");
const copyStatus = document.querySelector("#copy-status");

copyButton?.addEventListener("click", async () => {
  const text = copyButton.dataset.copy || "";
  try {
    await navigator.clipboard.writeText(text);
    copyStatus.textContent = "已复制：开始今天的英语学习";
    copyButton.textContent = "已复制";
  } catch {
    copyStatus.textContent = `请复制：${text}`;
  }
});

document.querySelectorAll("[data-scroll-target]").forEach((button) => {
  button.addEventListener("click", () => {
    document.getElementById(button.dataset.scrollTarget)?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
});
