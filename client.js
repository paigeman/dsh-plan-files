// DSH serves client bundles as classic scripts through its module loader.
globalThis.__ModuleLoader__.load({
  id: "dsh-plan-files",
  factory(require) {
    const { createElement: element, useState } = require("react");
    const slot = "conversation.plan-review.actions";
    const namespace = "plan-files-review";
    const pathLine = "\nPlan file: ";

    function PlanPath({ review, t }) {
      const [copied, setCopied] = useState();
      const question = review?.question;
      if (typeof question !== "string") return null;
      const marker = question.lastIndexOf(pathLine);
      if (marker === -1) return null;
      const displayPath = question.slice(marker + pathLine.length);
      let path = displayPath;
      if (displayPath.startsWith('"')) {
        try {
          path = JSON.parse(displayPath);
        } catch {
          return null;
        }
      }
      if (!path) return null;

      const label = copied?.path === path ? t(copied.key) : t("copy");
      const nameOffset = Math.max(displayPath.lastIndexOf("/"), displayPath.lastIndexOf("\\")) + 1;
      const truncate = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
      return element(
        "button",
        {
          type: "button",
          title: `${label}\n${displayPath}`,
          "aria-label": `${label} ${displayPath}`,
          onClick: async () => {
            try {
              await globalThis.navigator.clipboard.writeText(path);
              setCopied({ path, key: "copied" });
            } catch {
              setCopied({ path, key: "copyFailed" });
            }
          },
          style: {
            display: "inline-flex",
            minWidth: 0,
            maxWidth: "min(42vw, 28rem)",
            marginInlineEnd: 8,
            padding: "2px 4px",
            color: "var(--dsw-alias-label-secondary)",
            background: "transparent",
            border: 0,
            cursor: "copy",
            fontFamily: "monospace",
            fontSize: "inherit",
          },
        },
        element("span", { style: truncate }, displayPath.slice(0, nameOffset)),
        element(
          "span",
          { style: { ...truncate, flexShrink: 0, maxWidth: "80%" } },
          displayPath.slice(nameOffset),
        ),
      );
    }

    return {
      inject: ["slots", "locale"],
      apply(ctx) {
        ctx.effect(() =>
          ctx.locale.register(namespace, {
            en: {
              copy: "Copy plan path",
              copied: "Plan path copied",
              copyFailed: "Could not copy plan path",
            },
            zh: { copy: "复制计划路径", copied: "已复制计划路径", copyFailed: "无法复制计划路径" },
          }),
        );
        ctx.slots.inject(slot, () =>
          ctx.slots.register(
            { name: slot, id: namespace, locale: namespace, order: -10 },
            PlanPath,
          ),
        );
      },
    };
  },
});
