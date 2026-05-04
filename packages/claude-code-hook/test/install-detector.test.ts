import test from "node:test";
import assert from "node:assert/strict";
import { detectInstall } from "../src/install-detector.ts";

// ---------- npm family ----------

test("detect: npm install <pkg>", () => {
  const r = detectInstall("npm install lodash");
  assert.equal(r?.ecosystem, "npm");
  assert.equal(r?.manager, "npm");
  assert.deepEqual(r?.packages, [{ name: "lodash" }]);
});

test("detect: npm i with version", () => {
  const r = detectInstall("npm i react@18.2.0");
  assert.deepEqual(r?.packages, [{ name: "react", version: "18.2.0" }]);
});

test("detect: npm install with multiple packages", () => {
  const r = detectInstall("npm install axios chalk uuid");
  assert.equal(r?.packages.length, 3);
  assert.deepEqual(
    r?.packages.map((p) => p.name).sort(),
    ["axios", "chalk", "uuid"],
  );
});

test("detect: npm install with scoped package", () => {
  const r = detectInstall("npm install @types/node@^22");
  assert.deepEqual(r?.packages, [{ name: "@types/node", version: "^22" }]);
});

test("detect: pnpm add", () => {
  const r = detectInstall("pnpm add fastify");
  assert.equal(r?.manager, "pnpm");
  assert.deepEqual(r?.packages, [{ name: "fastify" }]);
});

test("detect: yarn add", () => {
  const r = detectInstall("yarn add zod");
  assert.equal(r?.manager, "yarn");
});

test("detect: bun add", () => {
  const r = detectInstall("bun add tsx");
  assert.equal(r?.manager, "bun");
  assert.equal(r?.ecosystem, "npm");
});

test("detect: bare 'npm install' (no args) returns null", () => {
  // bare install pulls from package.json, not an explicit add
  assert.equal(detectInstall("npm install"), null);
});

test("detect: ignores URLs and tarballs", () => {
  const r = detectInstall("npm install ./local-pkg.tgz https://x/y/foo.tgz");
  assert.equal(r, null);
});

test("detect: skips flag values", () => {
  const r = detectInstall("npm install --registry https://nope.com axios");
  assert.deepEqual(r?.packages, [{ name: "axios" }]);
});

// ---------- pip family ----------

test("detect: pip install with pinned version", () => {
  const r = detectInstall("pip install requests==2.31.0");
  assert.equal(r?.ecosystem, "pypi");
  assert.deepEqual(r?.packages, [{ name: "requests", version: "2.31.0" }]);
});

test("detect: pip install with extras", () => {
  const r = detectInstall("pip install requests[security]==2.31.0");
  assert.equal(r?.packages[0].name, "requests");
  assert.equal(r?.packages[0].version, "2.31.0");
});

test("detect: pip install range (no version captured)", () => {
  const r = detectInstall("pip install 'numpy>=1.20'");
  assert.equal(r?.packages[0].name, "numpy");
  assert.equal(r?.packages[0].version, undefined);
});

test("detect: pip3 install", () => {
  const r = detectInstall("pip3 install httpx");
  assert.equal(r?.manager, "pip3");
});

test("detect: python -m pip install", () => {
  const r = detectInstall("python3 -m pip install pandas");
  assert.equal(r?.ecosystem, "pypi");
  assert.equal(r?.packages[0].name, "pandas");
});

test("detect: uv pip install", () => {
  const r = detectInstall("uv pip install fastapi==0.110");
  assert.equal(r?.manager, "uv pip");
  assert.deepEqual(r?.packages, [{ name: "fastapi", version: "0.110" }]);
});

test("detect: uv add", () => {
  const r = detectInstall("uv add httpx");
  assert.equal(r?.manager, "uv");
});

test("detect: poetry add", () => {
  const r = detectInstall("poetry add black");
  assert.equal(r?.manager, "poetry");
});

// ---------- compound commands ----------

test("detect: scans across && segments", () => {
  const r = detectInstall("git clone foo && cd foo && npm install lodash");
  assert.deepEqual(r?.packages, [{ name: "lodash" }]);
});

test("detect: scans across ;", () => {
  const r = detectInstall("ls; pip install requests");
  assert.equal(r?.packages[0].name, "requests");
});

// ---------- unrelated commands ----------

test("detect: ls -> null", () => {
  assert.equal(detectInstall("ls -la"), null);
});

test("detect: git pull -> null", () => {
  assert.equal(detectInstall("git pull origin main"), null);
});

test("detect: pip list -> null (not install verb)", () => {
  assert.equal(detectInstall("pip list"), null);
});

test("detect: npm test -> null", () => {
  assert.equal(detectInstall("npm test"), null);
});
