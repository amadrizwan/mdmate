import { mkdir, copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const vendorRoot = path.join(projectRoot, "vendor", "asciiflow");
const outRoot = path.join(projectRoot, "assets", "asciiflow");
const publicRoot = path.join(outRoot, "public");
const publicFonts = path.join(publicRoot, "fonts");

const asciiflowResolvePlugin = {
  name: "asciiflow-resolve",
  setup(build) {
    build.onResolve({ filter: /^#asciiflow\// }, (args) => {
      const relativePath = `./${args.path.replace(/^#asciiflow\//, "")}`;
      return build.resolve(relativePath, {
        resolveDir: vendorRoot,
        kind: args.kind,
      });
    });
  },
};

async function ensureOutputStructure() {
  await mkdir(outRoot, { recursive: true });
  await mkdir(publicRoot, { recursive: true });
  await mkdir(publicFonts, { recursive: true });
}

async function copyStaticAssets() {
  const sourcePublic = path.join(vendorRoot, "client", "public");
  await copyFile(path.join(sourcePublic, "favicon.png"), path.join(publicRoot, "favicon.png"));
  await copyFile(path.join(sourcePublic, "logo_min.svg"), path.join(publicRoot, "logo_min.svg"));
  await copyFile(path.join(sourcePublic, "logo_full.svg"), path.join(publicRoot, "logo_full.svg"));
  await copyFile(path.join(sourcePublic, "github_mark.png"), path.join(publicRoot, "github_mark.png"));

  await copyFile(
    path.join(projectRoot, "assets", "fonts", "SourceCodePro-Regular.ttf"),
    path.join(publicFonts, "SourceCodePro-Regular.ttf")
  );
  await copyFile(
    path.join(projectRoot, "assets", "fonts", "SourceCodePro-Medium.ttf"),
    path.join(publicFonts, "SourceCodePro-Medium.ttf")
  );
}

async function writeAsciiFlowIndex() {
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ASCIIFlow</title>
  <link rel="shortcut icon" sizes="196x196" href="./public/favicon.png" />
  <link rel="stylesheet" href="./bundle.css" />
  <style>
    @font-face {
      font-family: "Source Code Pro";
      font-style: normal;
      font-weight: 400;
      font-display: block;
      src: url("./public/fonts/SourceCodePro-Regular.ttf") format("truetype");
    }
    @font-face {
      font-family: "Source Code Pro";
      font-style: normal;
      font-weight: 500;
      font-display: block;
      src: url("./public/fonts/SourceCodePro-Medium.ttf") format("truetype");
    }
    html, body, #root { width: 100%; height: 100%; margin: 0; overflow: hidden; }
    * { font-family: "Source Code Pro", monospace; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script src="./bundle.js"></script>
</body>
</html>
`;
  await writeFile(path.join(outRoot, "index.html"), html, "utf8");
}

async function buildBundle() {
  await esbuild.build({
    entryPoints: [path.join(vendorRoot, "client", "app.tsx")],
    bundle: true,
    outfile: path.join(outRoot, "bundle.js"),
    platform: "browser",
    target: ["es2020"],
    format: "iife",
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    loader: {
      ".png": "file",
      ".svg": "file",
    },
    plugins: [asciiflowResolvePlugin],
    minify: true,
    sourcemap: false,
  });
}

async function main() {
  await ensureOutputStructure();
  await buildBundle();
  await copyStaticAssets();
  await writeAsciiFlowIndex();
  process.stdout.write("Built AsciiFlow bundle into assets/asciiflow\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
