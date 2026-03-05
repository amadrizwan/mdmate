import { parentPort } from "node:worker_threads";
import { createRequire } from "node:module";
import { evaluate } from "@mdx-js/mdx";
import remarkGfm from "remark-gfm";

const require = createRequire(import.meta.url);
const runtime = require("react/jsx-runtime");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

// Built-in components
function Callout({ type = "info", title, children }) {
  const colors = {
    info: { bg: "#eff6ff", border: "#3b82f6", color: "#1e40af" },
    warning: { bg: "#fffbeb", border: "#f59e0b", color: "#92400e" },
    error: { bg: "#fef2f2", border: "#ef4444", color: "#991b1b" },
    success: { bg: "#f0fdf4", border: "#22c55e", color: "#166534" },
  };
  const s = colors[type] || colors.info;
  const propsJson = JSON.stringify({ type, ...(title ? { title } : {}) });
  return React.createElement("div", {
    "data-mdx-component": "Callout",
    "data-mdx-props": propsJson,
    style: {
      padding: "12px 16px",
      margin: "12px 0",
      borderLeft: `4px solid ${s.border}`,
      background: s.bg,
      color: s.color,
      borderRadius: "4px",
    },
  },
    title ? React.createElement("strong", { style: { display: "block", marginBottom: "4px" } }, title) : null,
    children
  );
}

function Badge({ color = "#e86a33", children }) {
  const propsJson = JSON.stringify({ color });
  return React.createElement("span", {
    "data-mdx-component": "Badge",
    "data-mdx-props": propsJson,
    style: {
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: "999px",
      fontSize: "0.85em",
      fontWeight: 600,
      background: color,
      color: "#fff",
    },
  }, children);
}

function Tabs({ labels = [], children }) {
  const items = Array.isArray(children) ? children : [children];
  const propsJson = JSON.stringify({ labels });
  return React.createElement("div", {
    "data-mdx-component": "Tabs",
    "data-mdx-props": propsJson,
    style: { border: "1px solid #ded7c9", borderRadius: "8px", margin: "12px 0", overflow: "hidden" },
  }, ...items.map((child, i) =>
    React.createElement("div", { key: i },
      React.createElement("div", {
        style: {
          padding: "8px 12px",
          background: "#f8f2e6",
          fontWeight: 700,
          fontSize: "0.9em",
          borderBottom: "1px solid #ded7c9",
        },
      }, (labels && labels[i]) || `Tab ${i + 1}`),
      React.createElement("div", { style: { padding: "12px" } }, child)
    )
  ));
}

function remarkPreserveMdxConstructs() {
  return (tree) => {
    tree.children = tree.children.map((node) => {
      if (node.type === "mdxjsEsm") {
        return {
          type: "code",
          lang: "mdx-esm",
          value: node.value,
          data: { hProperties: { "data-mdx-esm": "true" } },
        };
      }
      return node;
    });

    const visitExpressions = (node) => {
      if (node.type === "mdxFlowExpression") {
        Object.assign(node, {
          type: "code",
          lang: "mdx-expr",
          value: `{${node.value}}`,
          children: undefined,
          data: { hProperties: { "data-mdx-expr": "true" } },
        });
      }
      if (node.type === "mdxTextExpression") {
        Object.assign(node, {
          type: "inlineCode",
          value: `{${node.value}}`,
          children: undefined,
          data: { hProperties: { "data-mdx-expr": "true" } },
        });
      }
      if (node.children) node.children.forEach(visitExpressions);
    };
    visitExpressions(tree);
  };
}

function remarkLiveCodeBlocks() {
  return (tree) => {
    const visit = (node) => {
      if (node.type === "code" && node.meta && node.meta.includes("live") && /^jsx?$/i.test(node.lang || "")) {
        if (!node.data) node.data = {};
        if (!node.data.hProperties) node.data.hProperties = {};
        node.data.hProperties["data-meta"] = "live";
      }
      if (node.children) node.children.forEach(visit);
    };
    visit(tree);
  };
}

const builtinComponents = { Callout, Badge, Tabs };

parentPort.on("message", async ({ id, source }) => {
  try {
    const { default: MDXContent } = await evaluate(source, {
      ...runtime,
      remarkPlugins: [remarkGfm, remarkPreserveMdxConstructs, remarkLiveCodeBlocks],
      // No baseUrl — disables import/export resolution for security
    });
    const html = renderToStaticMarkup(runtime.jsx(MDXContent, { components: builtinComponents }));
    parentPort.postMessage({ id, html, error: null });
  } catch (err) {
    parentPort.postMessage({ id, html: null, error: err.message });
  }
});
